// A small in-memory limiter: at most `max` hits per key in each window.
module.exports = function rateLimit({ max, windowMs }) {
    const entries = new Map();

    function current(key) {
        const e = entries.get(key);
        if (e && e.until > Date.now()) return e;
        entries.delete(key);
        return null;
    }

    return {
        allow: (key) => (current(key)?.count || 0) < max,
        hit(key) {
            if (entries.size > 10000) entries.clear();
            const e = current(key) || { count: 0, until: Date.now() + windowMs };
            e.count++;
            entries.set(key, e);
        },
        reset: (key) => entries.delete(key)
    };
};
