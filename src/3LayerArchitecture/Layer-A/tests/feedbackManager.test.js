const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const { canSubmit, markSubmitted } = require('../utils/feedbackManager');

describe('feedbackManager', () => {
    const OriginalDate = global.Date;

    afterEach(() => {
        global.Date = OriginalDate;
    });

    function setMockDate(dateString) {
        const mockDate = new OriginalDate(dateString);
        global.Date = class extends OriginalDate {
            constructor(...args) {
                if (args.length === 0) return mockDate;
                return new OriginalDate(...args);
            }
            static now() {
                return mockDate.getTime();
            }
        };
    }

    test('canSubmit should return true initially', () => {
        const userId = 'user_initial';
        setMockDate('2023-10-15T12:00:00Z');
        assert.strictEqual(canSubmit(userId), true);
    });

    test('canSubmit should return false on the same day after markSubmitted', () => {
        const userId = 'user_same_day';
        setMockDate('2023-10-15T12:00:00Z');

        assert.strictEqual(canSubmit(userId), true);
        markSubmitted(userId);
        assert.strictEqual(canSubmit(userId), false);
    });

    test('canSubmit should return true on the next day', () => {
        const userId = 'user_next_day';

        // Day 1
        setMockDate('2023-10-15T12:00:00Z');
        assert.strictEqual(canSubmit(userId), true);
        markSubmitted(userId);
        assert.strictEqual(canSubmit(userId), false);

        // Day 2
        setMockDate('2023-10-16T12:00:00Z');
        assert.strictEqual(canSubmit(userId), true);
    });

    test('should treat numeric and string user IDs the same', () => {
        const userIdNum = 12345;
        const userIdStr = '12345';

        setMockDate('2023-10-15T12:00:00Z');
        assert.strictEqual(canSubmit(userIdNum), true);
        markSubmitted(userIdNum);

        assert.strictEqual(canSubmit(userIdStr), false);
        assert.strictEqual(canSubmit(userIdNum), false);
    });
});
