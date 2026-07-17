module.exports = function (RED) {
    "use strict";

    const UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
    const MINUTE_MS = 60000;
    const WEEK_MINUTES = 7 * 24 * 60; // 10080 one-minute buckets
    const MAX_DISTINCT_PAYLOADS = 500;
    const TOP_N = 10;
    const MAX_KEY_LENGTH = 120;

    function toMs(value, unit) {
        const n = Number(value);
        return (isFinite(n) && n > 0) ? n * (UNIT_MS[unit] || 1000) : 0;
    }

    // Single largest unit only, e.g. "5s ago", "3m ago", "2h ago", "4d ago".
    function humanize(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60) return s + "s ago";
        const m = Math.floor(s / 60);
        if (m < 60) return m + "m ago";
        const h = Math.floor(m / 60);
        if (h < 24) return h + "h ago";
        const d = Math.floor(h / 24);
        return d + "d ago";
    }

    function safeKey(payload) {
        let s;
        try {
            s = (typeof payload === "string") ? payload : JSON.stringify(payload);
        } catch (e) {
            s = "[unserializable " + typeof payload + "]";
        }
        if (s === undefined) s = "undefined";
        if (s.length > MAX_KEY_LENGTH) s = s.slice(0, MAX_KEY_LENGTH) + "…";
        return s;
    }

    function evictLeastFrequent(map, maxSize) {
        if (map.size <= maxSize) return;
        const entries = Array.from(map.entries()).sort((a, b) => a[1] - b[1]);
        const toRemove = entries.slice(0, map.size - maxSize);
        for (const [key] of toRemove) map.delete(key);
    }

    function topN(map, n) {
        return Array.from(map.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([value, count]) => ({ value, count }));
    }

    function SignalboxNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.colorThresholds = !!config.colorThresholds;
        node.warnAfterMs = toMs(config.warnAfter, config.warnAfterUnit);
        node.errorAfterMs = toMs(config.errorAfter, config.errorAfterUnit);
        node.updateIntervalMs = toMs(config.updateInterval, config.updateIntervalUnit) || 5000;
        node.trackTopPayloads = !!config.trackTopPayloads;
        node.topPayloadsResetMs = toMs(config.topPayloadsResetEvery, config.topPayloadsResetEveryUnit) || 86400000;

        const displayName = config.name || ("signalbox:" + node.id.slice(0, 8));

        if (node.colorThresholds && node.errorAfterMs > 0 &&
            node.warnAfterMs > 0 && node.errorAfterMs <= node.warnAfterMs) {
            node.warn("signalbox: 'error after' should be greater than 'warn after' - thresholds may not behave as expected");
        }

        // ---- Live counters (cheap, updated synchronously on every message) ----
        let lastSeen = null;
        let totalCount = 0;
        let avgIntervalMs = null;
        const buckets = new Array(WEEK_MINUTES).fill(0);
        let bucketHead = 0;              // index of the slot representing the current minute
        let bucketHeadMinute = null;     // which minute-index that slot currently represents
        let payloadFreq = new Map();
        let payloadFreqSince = Date.now();

        function rollBuckets(now) {
            const currentMinute = Math.floor(now / MINUTE_MS);
            if (bucketHeadMinute === null) {
                bucketHeadMinute = currentMinute;
                return;
            }
            let steps = currentMinute - bucketHeadMinute;
            if (steps <= 0) return;
            if (steps > WEEK_MINUTES) steps = WEEK_MINUTES; // more time passed than the buffer covers
            for (let i = 0; i < steps; i++) {
                bucketHead = (bucketHead + 1) % WEEK_MINUTES;
                buckets[bucketHead] = 0;
            }
            bucketHeadMinute = currentMinute;
        }

        function sumLast(nMinutes) {
            const n = Math.min(nMinutes, WEEK_MINUTES);
            let sum = 0;
            let idx = bucketHead;
            for (let i = 0; i < n; i++) {
                sum += buckets[idx];
                idx = (idx - 1 + WEEK_MINUTES) % WEEK_MINUTES;
            }
            return sum;
        }

        function showStatus(now) {
            if (lastSeen === null) {
                node.status({ fill: "grey", shape: "ring", text: "no messages yet" });
                return;
            }
            rollBuckets(now);
            const elapsed = now - lastSeen;
            const hourCount = sumLast(60);
            const dayCount = sumLast(24 * 60);
            const text = humanize(elapsed) + " · " + hourCount + "/hr · " + dayCount + "/day";

            if (!node.colorThresholds) {
                node.status({ fill: "blue", shape: "dot", text: text });
                return;
            }
            let fill = "green";
            if (node.errorAfterMs > 0 && elapsed >= node.errorAfterMs) {
                fill = "red";
            } else if (node.warnAfterMs > 0 && elapsed >= node.warnAfterMs) {
                fill = "yellow";
            }
            node.status({ fill: fill, shape: "dot", text: text });
        }

        async function writeSnapshot() {
            const now = Date.now();
            rollBuckets(now);

            const snapshot = {
                id: node.id,
                name: displayName,
                lastSeen: lastSeen,
                counts: {
                    hour: sumLast(60),
                    day: sumLast(24 * 60),
                    week: sumLast(WEEK_MINUTES),
                    total: totalCount
                },
                avgIntervalMs: avgIntervalMs,
                updated: now
            };

            if (node.trackTopPayloads) {
                snapshot.topPayloads = topN(payloadFreq, TOP_N);
                snapshot.topPayloadsSince = payloadFreqSince;
            }

            try {
                node.context().set("signalbox", snapshot);
            } catch (err) {
                node.warn("signalbox: could not write node context: " + err.message);
            }

            try {
                const globalContext = node.context().global;
                let all = await Promise.resolve(globalContext.get("signalbox"));
                if (!all || typeof all !== "object") all = {};
                all[node.id] = snapshot;
                await Promise.resolve(globalContext.set("signalbox", all));
            } catch (err) {
                node.warn("signalbox: could not write global.signalbox: " + err.message);
            }

            showStatus(now);
        }

        showStatus(Date.now());
        const timer = setInterval(writeSnapshot, node.updateIntervalMs);

        node.on("input", function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            const now = Date.now();

            if (lastSeen !== null) {
                const interval = now - lastSeen;
                avgIntervalMs = (avgIntervalMs === null) ? interval : (avgIntervalMs * 0.9 + interval * 0.1);
            }
            lastSeen = now;
            totalCount++;

            rollBuckets(now);
            buckets[bucketHead]++;

            if (node.trackTopPayloads) {
                if (now - payloadFreqSince > node.topPayloadsResetMs) {
                    payloadFreq = new Map();
                    payloadFreqSince = now;
                }
                const key = safeKey(msg.payload);
                payloadFreq.set(key, (payloadFreq.get(key) || 0) + 1);
                if (payloadFreq.size > MAX_DISTINCT_PAYLOADS) {
                    evictLeastFrequent(payloadFreq, MAX_DISTINCT_PAYLOADS);
                }
            }

            send(msg);
            done();
        });

        node.on("close", function (done) {
            clearInterval(timer);
            if (typeof done === "function") done();
        });
    }

    RED.nodes.registerType("signalbox", SignalboxNode);
};
