let express = require("express");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const { badgeConstants } = require("../../src/util");
const { makeBadge } = require("badge-maker");
const { UptimeCalculator } = require("../uptime-calculator");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status/:slug/rss", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageRSSResponse(response, slug, request);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        // Response
        response.json(statusPageData);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
router.get("/api/status-page/heartbeat/:slug", cache("10 seconds"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        // Get duration and numPoints from query
        let duration = request.query.duration || "24";
        let durationHours = parseInt(duration);

        let numPoints = parseInt(request.query.numPoints) || 100;
        // Cap numPoints to reasonable values
        numPoints = Math.max(10, Math.min(200, numPoints));

        // Use a single "now" for all monitors to ensure consistency
        let now = dayjs().utc();

        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        for (let monitorID of monitorIDList) {
            let result = [];
            let startTime = now.subtract(durationHours, "hour");

            // Spread points from startTime to now exactly
            // Step size = (duration in seconds) / (numPoints - 1)
            const stepSeconds = (durationHours * 3600) / (numPoints - 1);

            // Fetch the last heartbeat BEFORE the startTime to know the initial state
            // Use SQL_DATETIME_FORMAT for consistency
            const SQL_DATETIME_FORMAT = "YYYY-MM-DD HH:mm:ss";
            // Monitörün tarihteki en ilk pingi (oluşturulma veya aktifleşme anı) - GÜVENLİ ÇAĞRI (R.getRow)
            let veryFirstHeartbeatRow = await R.getRow("SELECT time FROM heartbeat WHERE monitor_id = ? ORDER BY time ASC LIMIT 1", [monitorID]);
            let firstHeartbeatTime = veryFirstHeartbeatRow && veryFirstHeartbeatRow.time ? dayjs.utc(veryFirstHeartbeatRow.time) : null;

            let initialHeartbeat = await R.getRow(
                "SELECT status FROM heartbeat WHERE monitor_id = ? AND time < ? ORDER BY time DESC LIMIT 1",
                [monitorID, startTime.format(SQL_DATETIME_FORMAT)]
            );

            let currentStatus = initialHeartbeat && initialHeartbeat.status !== 2 ? initialHeartbeat.status : null;

            // Fetch raw heartbeats for the period for better accuracy
            let heartbeats = await R.getAll(
                `
                SELECT status, time, ping FROM heartbeat
                WHERE monitor_id = ? AND time >= ?
                ORDER BY time ASC
            `,
                [monitorID, startTime.format(SQL_DATETIME_FORMAT)]
            );

            // Aggregate heartbeats into buckets
            for (let i = 0; i < numPoints; i++) {
                let bucketTime = startTime.add(i * stepSeconds, "second");
                // For the very last point, ensure it's exactly 'now' to avoid "X minutes ago"
                if (i === numPoints - 1) {
                    bucketTime = now;
                }

                // Use a slightly larger window for bucket matching to avoid missing heartbeats
                // precisely at the boundaries
                let bucketStartTime = bucketTime.subtract(stepSeconds / 2, "second");
                let bucketEndTime = bucketTime.add(stepSeconds / 2, "second");

                // Çok kritik blok: Eğer bu zaman dilimi, monitörün kurulduğu/ilk ping attığı zamandan ÖNCE ise:
                if (!firstHeartbeatTime || bucketEndTime.isBefore(firstHeartbeatTime)) {
                    result.push(0); // 0 değeri frontend tarafından doğrudan 'empty: true' (Gri) olarak algılanır.
                    continue; // Geri kalan renk hesaplamalarını atla
                }

                let heartbeatsInBucket = heartbeats.filter((h) => {
                    // Database time is UTC string, parse it as UTC
                    let hTime = dayjs.utc(h.time);
                    return (
                        (hTime.isAfter(bucketStartTime) || hTime.isSame(bucketStartTime)) &&
                        hTime.isBefore(bucketEndTime)
                    );
                });

                let status = currentStatus;
                let avgPing = null;
                let bucketTimestamp = bucketTime.toISOString(); // Default to bucket center

                if (heartbeatsInBucket.length > 0) {
                    // Find the "representative" heartbeat for this bucket
                    // Priority: DOWN (0) > MAINTENANCE (3) > UP (1)
                    let downBeat = heartbeatsInBucket.find((h) => h.status === 0);
                    let maintenanceBeat = heartbeatsInBucket.find((h) => h.status === 3);
                    let upBeat = heartbeatsInBucket[heartbeatsInBucket.length - 1]; // Get latest for UP

                    if (downBeat) {
                        status = 0;
                        bucketTimestamp = dayjs.utc(downBeat.time).toISOString();
                    } else if (maintenanceBeat) {
                        status = 3;
                        bucketTimestamp = dayjs.utc(maintenanceBeat.time).toISOString();
                    } else if (upBeat) {
                        status = 1;
                        bucketTimestamp = dayjs.utc(upBeat.time).toISOString();
                    }

                    // Update currentStatus for the next bucket
                    currentStatus = status;

                    let upBeats = heartbeatsInBucket.filter((h) => h.status === 1);
                    if (upBeats.length > 0) {
                        let sum = heartbeatsInBucket.reduce((acc, h) => acc + (h.ping || 0), 0);
                        avgPing = Math.round(sum / heartbeatsInBucket.length);
                    }

                    currentStatus = status;
                } else {
                    // EĞER VERİTABANINDA BU ZAMAN DİLİMİNE AİT HİÇ VERİ YOKSA:
                    // Son bilinen durumu taşımak yerine, durumu mecburen null (gri) yapıyoruz.
                    status = null;
                }

                if (status === null) {
                    result.push(0);
                } else {
                    result.push({
                        status: status,
                        time: bucketTimestamp,
                        ping: avgPing,
                        msg: "",
                    });
                }
            }

            heartbeatList[monitorID] = result;
            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            let uptimeResult = uptimeCalculator.getDataByDuration(durationHours + "h");
            uptimeList[`${monitorID}_${durationHours}`] = uptimeResult.uptime;
        }

        response.json({
            heartbeatList,
            uptimeList,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            name: statusPage.title,
            start_url: "/status/" + statusPage.slug,
            display: "standalone",
            icons: [
                {
                    src: statusPage.icon,
                    sizes: "128x128",
                    type: "image/png",
                },
            ],
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/status-page/:slug/incident-history", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        if (!statusPageID) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const cursor = request.query.cursor || null;
        const result = await StatusPage.getIncidentHistory(statusPageID, cursor, true);
        response.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    const statusPageID = await StatusPage.slugToID(slug);
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle,
    } = request.query;

    try {
        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `,
                [monitorID]
            );

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }
        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Get exact downtime periods for a specific monitor in the given timeframe
router.get("/api/status-page/monitor-downtime/:slug/:monitorID", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        if (!statusPageID) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        let monitorID = request.params.monitorID;
        let durationHours = parseInt(request.query.duration) || 24;
        let startTime = dayjs().utc().subtract(durationHours, "hour");

        // Fetch raw heartbeats
        let heartbeats = await R.getAll(
            `
            SELECT status, time FROM heartbeat
            WHERE monitor_id = ? AND time >= ?
            ORDER BY time ASC
        `,
            [monitorID, startTime.format("YYYY-MM-DD HH:mm:ss")]
        );

        let downPeriods = [];
        let currentDown = null;

        for (let h of heartbeats) {
            if (h.status === 0 && !currentDown) {
                // System just went DOWN
                currentDown = { start: h.time };
            } else if (h.status !== 0 && currentDown) {
                // System came back UP
                currentDown.end = h.time;
                currentDown.durationMins = dayjs.utc(currentDown.end).diff(dayjs.utc(currentDown.start), "minute");
                downPeriods.push(currentDown);
                currentDown = null;
            }
        }
        
        // If it's still down at the end of the query
        if (currentDown) {
            currentDown.end = dayjs().utc().format("YYYY-MM-DD HH:mm:ss");
            currentDown.durationMins = dayjs().utc().diff(dayjs.utc(currentDown.start), "minute");
            currentDown.ongoing = true;
            downPeriods.push(currentDown);
        }

        // Return latest first
        downPeriods.reverse();

        response.json({
            ok: true,
            downtimes: downPeriods,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
