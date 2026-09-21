// get_time - tool definition
const TOOL_META = {
    "name": "get_time",
    "description": "Get the current date and time. Optionally accepts an IANA timezone identifier.",
    "parameters": {
        "type": "object",
        "properties": {
            "timezone": {
                "type": "string",
                "description": "Optional IANA timezone name (e.g., 'UTC', 'America/New_York', 'Asia/Tokyo'). Defaults to system local timezone."
            }
        }
    },
    "modes": [
        "code",
        "ask",
        "plan"
    ],
    "permission": "auto",
    "toolBox": 1,
    "settings": [
        {
            "key": "format",
            "label": "Time Format",
            "type": "select",
            "options": ["simple", "detailed", "extra detailed"],
            "default": "detailed",
            "description": "Choose between numeric ('simple'), extense ('detailed'), or full calendar breakdown with day of year/week number ('extra detailed')."
        },
        {
            "key": "showTimezone",
            "label": "Show Timezone",
            "type": "boolean",
            "default": true,
            "description": "Append timezone name and offset to the output."
        }
    ]
};

async function handler(args, api) {
    try {
        const now = new Date();
        const tz = (args?.timezone && args.timezone.trim())
            ? args.timezone.trim()
            : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

        // Read preferences directly from tool settings
        const format = (await api.getSetting('format')) ?? 'simple';
        const showTimezone = (await api.getSetting('showTimezone')) ?? true;

        let result = '';

        if (format === 'simple') {
            // e.g., 14:20:30 / 09/21/2026
            const timePart = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).format(now);

            const datePart = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                month: '2-digit',
                day: '2-digit',
                year: 'numeric'
            }).format(now);

            result = `${timePart} / ${datePart}`;
        } else {
            // Base extense string: e.g., Sunday, May 20, 2026, 14:20:30
            result = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).format(now);
        }

        // Append timezone info if toggle is enabled
        if (showTimezone) {
            const tzOffset = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                timeZoneName: 'shortOffset'
            }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value || '';

            result += ` (${tz}${tzOffset ? `, ${tzOffset}` : ''})`;
        }

        // Add calendar metadata for "extra detailed"
        if (format === 'extra detailed') {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                year: 'numeric',
                month: 'numeric',
                day: 'numeric'
            }).formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: parseInt(p.value, 10) }), {});

            const year = parts.year;
            const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
            const totalDays = isLeapYear ? 366 : 365;

            // Day of year
            const startOfYear = new Date(Date.UTC(year, 0, 1));
            const currentDay = new Date(Date.UTC(year, parts.month - 1, parts.day));
            const dayOfYear = Math.floor((currentDay - startOfYear) / 86400000) + 1;

            // ISO Week number
            const d = new Date(Date.UTC(year, parts.month - 1, parts.day));
            const dayNum = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() + 4 - dayNum);
            const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            const weekNumber = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);

            result += `\nDay of Year: ${dayOfYear}/${totalDays} | Week: ${weekNumber} | Leap Year: ${isLeapYear ? 'Yes' : 'No'}`;
        }

        return result;
    } catch (e) {
        return `ERROR: ${e.message}`;
    }
}
