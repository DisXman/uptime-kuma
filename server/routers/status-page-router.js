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

const SQL_DATETIME_FORMAT = "YYYY-MM-DD HH:mm:ss";

let router = express.Router();

/**
 * Return public monitor ids for a status page.
 * @param {number} statusPageID Status page id
 * @returns {Promise<number[]>} Public monitor ids
 */
async function getPublicStatusPageMonitorIDs(statusPageID) {
    const monitorIDs = await R.getCol(
        `
        SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
        WHERE monitor_group.group_id = \`group\`.id
        AND public = 1
        AND \`group\`.status_page_id = ?
    `,
        [statusPageID]
    );

    return monitorIDs.map((monitorID) => Number(monitorID));
}

/**
 * Aggregate heartbeats into evenly spaced buckets while preserving the last known state.
 * @param {object} options Aggregation options
 * @param {import("dayjs").Dayjs} options.now Current time
 * @param {number} options.durationHours Requested duration in hours
 * @param {number} options.numPoints Number of buckets
 * @param {import("dayjs").Dayjs | null} options.firstHeartbeatTime First heartbeat time
 * @param {{ status: number, time: string } | null} options.initialHeartbeat Last heartbeat before the range
 * @param {{ status: number, time: string, ping: number | null, timestamp: number }[]} options.heartbeats Heartbeats within the range
 * @returns {{ status: number, time: string, ping: number | null, msg: string }[] | number[]} Aggregated heartbeat buckets
 */
function buildHeartbeatBuckets({ now, durationHours, numPoints, firstHeartbeatTime, initialHeartbeat, heartbeats }) {
    const result = [];
    const startTime = now.subtract(durationHours, "hour");
    const totalDurationMs = durationHours * 3600 * 1000;
    const stepMs = numPoints > 1 ? totalDurationMs / (numPoints - 1) : totalDurationMs;
    const startTimeMs = startTime.valueOf();
    const firstHeartbeatMs = firstHeartbeatTime ? firstHeartbeatTime.valueOf() : null;

    let heartbeatIndex = 0;
    let currentStatus = initialHeartbeat && initialHeartbeat.status !== 2 ? initialHeartbeat.status : null;
    let lastActualHeartbeatTime =
        initialHeartbeat && initialHeartbeat.status !== 2 && initialHeartbeat.time
            ? dayjs.utc(initialHeartbeat.time)
            : null;

    for (let i = 0; i < numPoints; i++) {
        const bucketTime = i === numPoints - 1 ? now : dayjs.utc(startTimeMs + i * stepMs);
        const bucketTimeMs = bucketTime.valueOf();
        const bucketStartMs = bucketTimeMs - stepMs / 2;
        const bucketEndMs = bucketTimeMs + stepMs / 2;

        if (!firstHeartbeatMs || bucketEndMs < firstHeartbeatMs) {
            result.push(0);
            continue;
        }

        const heartbeatsInBucket = [];
        while (heartbeatIndex < heartbeats.length && heartbeats[heartbeatIndex].timestamp < bucketEndMs) {
            const heartbeat = heartbeats[heartbeatIndex];
            if (heartbeat.timestamp >= bucketStartMs) {
                heartbeatsInBucket.push(heartbeat);
            }
            heartbeatIndex++;
        }

        if (heartbeatsInBucket.length === 0) {
            if (currentStatus === null || !lastActualHeartbeatTime) {
                result.push(0);
            } else {
                result.push({
                    status: currentStatus,
                    time: lastActualHeartbeatTime.toISOString(),
                    ping: null,
                    msg: "",
                });
            }
            continue;
        }

        let representativeHeartbeat = heartbeatsInBucket.find((heartbeat) => heartbeat.status === 0);
        if (!representativeHeartbeat) {
            representativeHeartbeat = heartbeatsInBucket.find((heartbeat) => heartbeat.status === 3);
        }
        if (!representativeHeartbeat) {
            representativeHeartbeat = heartbeatsInBucket[heartbeatsInBucket.length - 1];
        }

        currentStatus = representativeHeartbeat.status === 2 ? currentStatus : representativeHeartbeat.status;
        lastActualHeartbeatTime = dayjs.utc(representativeHeartbeat.time);

        const upHeartbeats = heartbeatsInBucket.filter((heartbeat) => heartbeat.status === 1 && heartbeat.ping != null);
        const avgPing =
            upHeartbeats.length > 0
                ? Math.round(upHeartbeats.reduce((sum, heartbeat) => sum + heartbeat.ping, 0) / upHeartbeats.length)
                : null;

        result.push({
            status: currentStatus,
            time: lastActualHeartbeatTime.toISOString(),
            ping: avgPing,
            msg: "",
        });
    }

    return result;
}

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
        if (Number.isNaN(durationHours) || durationHours <= 0) {
            durationHours = 24;
        }

        let numPoints = parseInt(request.query.numPoints) || 100;
        // Cap numPoints to reasonable values
        numPoints = Math.max(10, Math.min(200, numPoints));

        // Use a single "now" for all monitors to ensure consistency
        let now = dayjs().utc();

        let monitorIDList = await getPublicStatusPageMonitorIDs(statusPageID);
        const startTime = now.subtract(durationHours, "hour");
        const startTimeSql = startTime.format(SQL_DATETIME_FORMAT);

        const monitorResults = await Promise.all(
            monitorIDList.map(async (monitorID) => {
                const [firstHeartbeatRow, initialHeartbeat, rawHeartbeats, uptimeCalculator] = await Promise.all([
                    R.getRow("SELECT time FROM heartbeat WHERE monitor_id = ? ORDER BY time ASC LIMIT 1", [monitorID]),
                    R.getRow(
                        "SELECT status, time FROM heartbeat WHERE monitor_id = ? AND time < ? ORDER BY time DESC LIMIT 1",
                        [monitorID, startTimeSql]
                    ),
                    R.getAll(
                        `
                    SELECT status, time, ping FROM heartbeat
                    WHERE monitor_id = ? AND time >= ?
                    ORDER BY time ASC
                `,
                        [monitorID, startTimeSql]
                    ),
                    UptimeCalculator.getUptimeCalculator(monitorID),
                ]);

                const heartbeats = rawHeartbeats.map((heartbeat) => ({
                    ...heartbeat,
                    timestamp: dayjs.utc(heartbeat.time).valueOf(),
                }));

                return {
                    monitorID,
                    heartbeatBuckets: buildHeartbeatBuckets({
                        now,
                        durationHours,
                        numPoints,
                        firstHeartbeatTime:
                            firstHeartbeatRow && firstHeartbeatRow.time ? dayjs.utc(firstHeartbeatRow.time) : null,
                        initialHeartbeat,
                        heartbeats,
                    }),
                    uptime: uptimeCalculator.getDataByDuration(`${durationHours}h`).uptime,
                };
            })
        );

        for (const monitorResult of monitorResults) {
            heartbeatList[monitorResult.monitorID] = monitorResult.heartbeatBuckets;
            uptimeList[`${monitorResult.monitorID}_${durationHours}`] = monitorResult.uptime;
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

        let monitorID = parseInt(request.params.monitorID);
        if (Number.isNaN(monitorID)) {
            sendHttpError(response, "Invalid Monitor ID");
            return;
        }

        let monitorIDList = await getPublicStatusPageMonitorIDs(statusPageID);
        if (!monitorIDList.includes(monitorID)) {
            sendHttpError(response, "Monitor Not Found");
            return;
        }

        let durationHours = parseInt(request.query.duration);
        if (Number.isNaN(durationHours) || durationHours <= 0) {
            durationHours = 24;
        }
        let startTime = dayjs().utc().subtract(durationHours, "hour");

        // Fetch raw heartbeats
        let heartbeats = await R.getAll(
            `
            SELECT status, time FROM heartbeat
            WHERE monitor_id = ? AND time >= ?
            ORDER BY time ASC
        `,
            [monitorID, startTime.format(SQL_DATETIME_FORMAT)]
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
