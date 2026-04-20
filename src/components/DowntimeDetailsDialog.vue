<template>
    <div ref="DowntimeDialog" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">{{ $t("Downtime History") }} - {{ monitorName }}</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>
                <div class="modal-body">
                    <div v-if="loading" class="text-center py-4">
                        <div class="spinner-border text-primary" role="status"></div>
                        <div class="mt-2 text-muted">{{ $t("Loading...") }}</div>
                    </div>

                    <div v-else-if="error" class="alert alert-danger">
                        {{ $t("downtimeHistoryError") }}: {{ error }}
                    </div>

                    <div v-else-if="downtimes.length === 0" class="text-center text-success py-4">
                        <font-awesome-icon icon="check-circle" size="3x" class="mb-3" />
                        <h5>{{ $t("downtimeHistoryEmptyTitle") }}</h5>
                        <p>{{ $t("downtimeHistoryEmptyText") }}</p>
                    </div>

                    <div v-else class="list-group">
                        <div v-for="(down, index) in downtimes" :key="index" class="list-group-item">
                            <div class="d-flex w-100 justify-content-between align-items-center mb-1">
                                <h6 class="mb-0 text-danger">
                                    <font-awesome-icon icon="exclamation-circle" class="me-1" />
                                    {{ $t("downtimeHistoryDownEvent") }}
                                </h6>
                                <span class="badge bg-danger rounded-pill fw-bold">
                                    {{ formatDuration(down.durationMins) }}
                                </span>
                            </div>
                            <small class="text-muted d-block mt-2">
                                <strong>{{ $t("downtimeHistoryStart") }}:</strong>
                                {{ formatTime(down.start) }}
                            </small>
                            <small class="text-muted d-block">
                                <strong>{{ $t("downtimeHistoryEnd") }}:</strong>
                                <span v-if="down.ongoing" class="text-warning">{{ $t("downtimeHistoryOngoing") }}</span>
                                <span v-else>{{ formatTime(down.end) }}</span>
                            </small>
                        </div>
                    </div>
                </div>

                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        {{ $t("Close") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import axios from "axios";
import dayjs from "dayjs";

export default {
    data() {
        return {
            modalInstance: null,
            loading: false,
            error: null,
            downtimes: [],
            monitorName: "",
        };
    },

    mounted() {
        this.modalInstance = new Modal(this.$refs.DowntimeDialog);
    },

    methods: {
        /**
         * Open the dialog and fetch downtime details
         * @param {string} slug Status page slug
         * @param {number|string} monitorId Monitor id
         * @param {number|string} duration Duration in hours
         * @param {string} name Monitor name
         * @returns {void}
         */
        show(slug, monitorId, duration, name) {
            this.monitorName = name;
            this.downtimes = [];
            this.error = null;
            this.loading = true;
            this.modalInstance.show();

            axios
                .get(`/api/status-page/monitor-downtime/${slug}/${monitorId}`, {
                    params: {
                        duration: duration,
                    },
                })
                .then((res) => {
                    this.loading = false;
                    if (res.data.ok) {
                        this.downtimes = res.data.downtimes;
                    }
                })
                .catch((err) => {
                    this.loading = false;
                    this.error = err.response?.data?.msg || err.message;
                });
        },

        formatTime(timeString) {
            if (!timeString) {
                return "-";
            }

            return this.$root.datetime(dayjs.utc(timeString).toISOString());
        },

        formatDuration(mins) {
            if (mins < 1) {
                return this.$t("lessThanOneMinute");
            }

            if (mins < 60) {
                return this.$t("minuteShort", mins);
            }

            let h = Math.floor(mins / 60);
            let m = mins % 60;

            if (m === 0) {
                return this.$t("hours", h);
            }

            return `${this.$t("hours", h)} ${this.$t("minuteShort", m)}`;
        },
    },
};
</script>

<style scoped>
.list-group-item {
    border-left: 4px solid #dc3545;
    background-color: var(--bs-body-bg);
    color: var(--bs-body-color);
}
.dark .list-group-item {
    background-color: #1e1e2d;
    border-color: #2b2b40;
    border-left: 4px solid #dc3545;
}
</style>
