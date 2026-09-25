// get_weather - tool definition.
const TOOL_META = {
    "name": "get_weather",
    "description": "Get current weather conditions and upcoming forecast for any city or location worldwide (no API key required).",
    "parameters": {
        "type": "object",
        "properties": {
            "location": {
                "type": "string",
                "description": "City name, region, or address (e.g. 'Tokyo', 'Paris, France', 'Austin, TX')."
            },
            "units": {
                "type": "string",
                "enum": ["celsius", "fahrenheit"],
                "description": "Temperature unit (default: 'celsius')."
            }
        },
        "required": [
            "location"
        ]
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "never",
    "toolBox": 1
};

async function handler(args, api) {
    const updateStatus = (msg) => {
        if (typeof api?.setHeaderMsg === 'function') {
            api.setHeaderMsg(msg);
        }
    };

    const locationQuery = (args.location || '').trim();
    if (!locationQuery) {
        return "ERROR: Provide a location to check the weather.";
    }

    const isFahrenheit = args.units === 'fahrenheit';
    const tempUnit = isFahrenheit ? '°F' : '°C';
    const windUnit = isFahrenheit ? 'mph' : 'km/h';
    const displayLoc = locationQuery.length > 35 ? locationQuery.slice(0, 32) + '...' : locationQuery;
    const TIMEOUT_MS = 10000;

    // Helper: fetch with timeout and CORS proxy fallbacks
    async function fetchJsonWithFallback(targetUrl, purposeLabel) {
        const attempts = [
            { url: targetUrl, label: 'direct' },
            { url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl), label: 'allorigins.win' },
            { url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(targetUrl), label: 'codetabs.com' },
            { url: 'https://corsproxy.io/?url=' + encodeURIComponent(targetUrl), label: 'corsproxy.io' }
        ];

        let lastError = null;
        for (let i = 0; i < attempts.length; i++) {
            const attempt = attempts[i];
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

            if (attempt.label === 'direct') {
                updateStatus(`${purposeLabel}...`);
            } else {
                updateStatus(`${purposeLabel} via ${attempt.label}...`);
            }

            try {
                const res = await fetch(attempt.url, { signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                return data;
            } catch (err) {
                lastError = err;
            } finally {
                clearTimeout(timer);
            }
        }
        throw new Error(`All attempts failed: ${lastError ? lastError.message : 'network error'}`);
    }

    // WMO Weather interpretation codes (WW)
    function decodeWeatherCode(code) {
        const map = {
            0: 'Clear sky',
            1: 'Mainly clear',
            2: 'Partly cloudy',
            3: 'Overcast',
            45: 'Fog',
            48: 'Depositing rime fog',
            51: 'Light drizzle',
            53: 'Moderate drizzle',
            55: 'Dense drizzle',
            56: 'Light freezing drizzle',
            57: 'Dense freezing drizzle',
            61: 'Slight rain',
            63: 'Moderate rain',
            65: 'Heavy rain',
            66: 'Light freezing rain',
            67: 'Heavy freezing rain',
            71: 'Slight snowfall',
            73: 'Moderate snowfall',
            75: 'Heavy snowfall',
            77: 'Snow grains',
            80: 'Slight rain showers',
            81: 'Moderate rain showers',
            82: 'Violent rain showers',
            85: 'Slight snow showers',
            86: 'Heavy snow showers',
            95: 'Thunderstorm',
            96: 'Thunderstorm with slight hail',
            99: 'Thunderstorm with heavy hail'
        };
        return map[code] || 'Variable conditions';
    }

    try {
        // Step 1: Geocoding lookup
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationQuery)}&count=1&language=en&format=json`;
        const geoData = await fetchJsonWithFallback(geoUrl, `Searching coordinates for "${displayLoc}"`);

        if (!geoData?.results || geoData.results.length === 0) {
            updateStatus(`Location not found: "${displayLoc}"`);
            return `ERROR: Location "${locationQuery}" could not be found. Please check spelling or add a country/state (e.g. 'Paris, TX' or 'Berlin, Germany').`;
        }

        const place = geoData.results[0];
        const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
        const { latitude, longitude, timezone } = place;

        // Step 2: Weather & Forecast lookup
        const tempParam = isFahrenheit ? '&temperature_unit=fahrenheit' : '';
        const windParam = isFahrenheit ? '&wind_speed_unit=mph' : '';
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=${encodeURIComponent(timezone || 'auto')}${tempParam}${windParam}`;

        const weatherData = await fetchJsonWithFallback(weatherUrl, `Fetching weather for ${place.name}`);

        const current = weatherData?.current;
        const daily = weatherData?.daily;

        if (!current) {
            updateStatus(`Failed to read weather data for ${place.name}`);
            return `ERROR: Weather data was not available for ${placeName}.`;
        }

        // Format Current Conditions
        const condition = decodeWeatherCode(current.weather_code);
        const temp = Math.round(current.temperature_2m);
        const feelsLike = Math.round(current.apparent_temperature);
        const humidity = current.relative_humidity_2m;
        const windSpeed = Math.round(current.wind_speed_10m);
        const precip = current.precipitation || 0;

        let output = `Weather for ${placeName}:\n`;
        output += `Condition: ${condition}\n`;
        output += `Temperature: ${temp}${tempUnit} (Feels like: ${feelsLike}${tempUnit})\n`;
        output += `Humidity: ${humidity}%\n`;
        output += `Wind Speed: ${windSpeed} ${windUnit}\n`;
        if (precip > 0) output += `Precipitation: ${precip} mm\n`;

        // Format 3-Day Forecast
        if (daily?.time && daily.time.length > 0) {
            output += `\nUpcoming Forecast:\n`;
            const daysCount = Math.min(daily.time.length, 4);
            for (let i = 1; i < daysCount; i++) {
                const date = daily.time[i];
                const dayCond = decodeWeatherCode(daily.weather_code[i]);
                const max = Math.round(daily.temperature_2m_max[i]);
                const min = Math.round(daily.temperature_2m_min[i]);
                const rainChance = daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : null;

                const rainStr = rainChance !== null ? ` | Rain: ${rainChance}%` : '';
                output += `- ${date}: ${dayCond}, ${min}${tempUnit} - ${max}${tempUnit}${rainStr}\n`;
            }
        }

        updateStatus(`Weather loaded: ${place.name} (${temp}${tempUnit})`);
        return output.trim();

    } catch (err) {
        updateStatus(`Failed getting weather for "${displayLoc}"`);
        return `ERROR: Could not retrieve weather for "${locationQuery}": ${err.message}`;
    }
}