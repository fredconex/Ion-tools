// show_progress - displays a horizontal chevron pipeline progress bar (dark theme)
const TOOL_META = {
    "name": "show_progress",
    "description": "Displays a horizontal chevron pipeline progress bar (arrow process flow) in dark theme. Updates the tool header message with progress/title and renders interlocking arrow chevrons for steps. Plain text only, no emojis.",
    "interactive": false,
    "toolBox": 1,
    "expanded": true,
    "parameters": {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Optional workflow or pipeline title displayed in the header message. Plain text only."
            },
            "current_step": {
                "type": "integer",
                "description": "1-based index of the currently active step (e.g. 1 for the first step)."
            },
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": { 
                            "type": "string", 
                            "description": "Short step title (e.g. 'Initiate', 'Business Case', 'Approval')." 
                        },
                        "description": { 
                            "type": "string", 
                            "description": "Optional short note, duration, or status subtitle." 
                        }
                    },
                    "required": ["title"]
                },
                "description": "List of all sequential steps in the pipeline."
            },
            "palette": {
                "type": "string",
                "enum": ["emerald", "blue", "teal", "red", "amber"],
                "description": "Color theme for the active/completed progression (default: 'emerald')."
            },
            "max_visible": {
                "type": "integer",
                "description": "Maximum number of steps to show at once (default 6, range 3-8). Shows continuation chevrons if steps exceed this."
            }
        },
        "required": ["current_step", "steps"]
    },
    "permission": "always"
};

function removeEmojis(str) {
    if (!str) return '';
    return String(str)
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/[\uFE0E\uFE0F]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

const PALETTES = {
    emerald: {
        completedBg: '#134e4a', // Dark cyan-teal
        completedText: '#99f6e4',
        activeBg: '#10b981',    // Vivid emerald
        activeText: '#ffffff',
        activeGlow: 'rgba(16, 185, 129, 0.45)'
    },
    blue: {
        completedBg: '#1e3a8a', // Deep navy blue
        completedText: '#bfdbfe',
        activeBg: '#2563eb',    // Bright royal blue
        activeText: '#ffffff',
        activeGlow: 'rgba(37, 99, 235, 0.45)'
    },
    teal: {
        completedBg: '#164e63', // Deep cyan
        completedText: '#a5f3fc',
        activeBg: '#06b6d4',    // Bright cyan/teal
        activeText: '#ffffff',
        activeGlow: 'rgba(6, 182, 212, 0.45)'
    },
    red: {
        completedBg: '#7f1d1d', // Dark wine red
        completedText: '#fecaca',
        activeBg: '#ef4444',    // Crimson
        activeText: '#ffffff',
        activeGlow: 'rgba(239, 68, 68, 0.45)'
    },
    amber: {
        completedBg: '#78350f', // Dark amber/brown
        completedText: '#fde68a',
        activeBg: '#f59e0b',    // Bright amber
        activeText: '#ffffff',
        activeGlow: 'rgba(245, 158, 11, 0.45)'
    }
};

function buildChevronPipelineHTML(steps, currentStep1Based, maxVisible = 6, paletteKey = 'emerald') {
    const total = steps.length;
    if (total === 0) return '';

    // Bound current step (0-indexed internally)
    const activeIdx = Math.max(0, Math.min(total - 1, (currentStep1Based || 1) - 1));
    const limit = Math.max(3, Math.min(maxVisible || 6, 8));

    // Calculate window around active step if steps exceed visible limit
    let startIdx = 0;
    let endIdx = total - 1;

    if (total > limit) {
        const half = Math.floor(limit / 2);
        startIdx = activeIdx - half;
        endIdx = startIdx + limit - 1;

        if (startIdx < 0) {
            endIdx += -startIdx;
            startIdx = 0;
        } else if (endIdx >= total) {
            startIdx -= (endIdx - total + 1);
            endIdx = total - 1;
        }
        startIdx = Math.max(0, startIdx);
        endIdx = Math.min(total - 1, endIdx);
    }

    const hasStartContinuation = startIdx > 0;
    const hasEndContinuation = endIdx < total - 1;
    const visibleSteps = steps.slice(startIdx, endIdx + 1);
    const palette = PALETTES[paletteKey] || PALETTES.emerald;

    // Arrow geometry constants (in px)
    const arrowDepth = 12;
    const arrowGap = 2.5;
    const overlapMargin = -(arrowDepth - arrowGap); // -9.5px creates an exact parallel gap

    // Start continuation chevron badge
    const startBadge = hasStartContinuation
        ? `<div style="
            flex: 0 0 58px;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #1f1f23;
            color: #71717a;
            font-size: 10px;
            font-weight: 600;
            clip-path: polygon(0 0, calc(100% - ${arrowDepth}px) 0, 100% 50%, calc(100% - ${arrowDepth}px) 100%, 0 100%);
            padding-right: 8px;
            box-sizing: border-box;
            white-space: nowrap;"
            title="${startIdx} prior step(s)">+${startIdx} prior</div>`
        : '';

    // Render visible chevron segments
    const chevronItems = visibleSteps.map((step, idx) => {
        const realIdx = startIdx + idx;
        const isCompleted = realIdx < activeIdx;
        const isActive = realIdx === activeIdx;

        const isAbsoluteFirst = realIdx === 0 && !hasStartContinuation;
        const isAbsoluteLast = realIdx === total - 1 && !hasEndContinuation;

        const cleanTitle = esc(removeEmojis(step.title) || `Step ${realIdx + 1}`);
        const cleanDesc = esc(removeEmojis(step.description));

        // Chevron clip-paths:
        // Flat left edge for workflow start; notched left edge for subsequent steps.
        // Flat right edge for workflow end; pointed right edge for preceding steps.
        let clipPath = '';
        let paddingLeft = `${arrowDepth + 6}px`;
        let paddingRight = `${arrowDepth + 6}px`;

        if (isAbsoluteFirst && isAbsoluteLast) {
            clipPath = 'none';
            paddingLeft = '12px';
            paddingRight = '12px';
        } else if (isAbsoluteFirst) {
            clipPath = `polygon(0 0, calc(100% - ${arrowDepth}px) 0, 100% 50%, calc(100% - ${arrowDepth}px) 100%, 0 100%)`;
            paddingLeft = '12px';
            paddingRight = `${arrowDepth + 6}px`;
        } else if (isAbsoluteLast) {
            clipPath = `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${arrowDepth}px 50%)`;
            paddingLeft = `${arrowDepth + 6}px`;
            paddingRight = '12px';
        } else {
            clipPath = `polygon(0 0, calc(100% - ${arrowDepth}px) 0, 100% 50%, calc(100% - ${arrowDepth}px) 100%, 0 100%, ${arrowDepth}px 50%)`;
            paddingLeft = `${arrowDepth + 6}px`;
            paddingRight = `${arrowDepth + 6}px`;
        }

        // Dark theme color assignment
        let bgColor = '#27272a'; // Zinc-800 upcoming
        let textColor = '#71717a';
        let fontWeight = '500';
        let zIndex = 1;
        let shadowStyle = '';

        if (isCompleted) {
            bgColor = palette.completedBg;
            textColor = palette.completedText;
            fontWeight = '600';
            zIndex = 2;
        } else if (isActive) {
            bgColor = palette.activeBg;
            textColor = palette.activeText;
            fontWeight = '700';
            zIndex = 4;
            shadowStyle = `filter: drop-shadow(0 0 8px ${palette.activeGlow});`;
        }

        const marginLeft = (idx === 0 && !hasStartContinuation) ? '0' : `${overlapMargin}px`;

        return `
            <div style="
                flex: 1 1 0;
                min-width: 82px;
                height: 100%;
                margin-left: ${marginLeft};
                clip-path: ${clipPath};
                background: ${bgColor};
                color: ${textColor};
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                padding-left: ${paddingLeft};
                padding-right: ${paddingRight};
                box-sizing: border-box;
                position: relative;
                z-index: ${zIndex};
                ${shadowStyle}
                user-select: none;"
                title="${cleanTitle}${cleanDesc ? ': ' + cleanDesc : ''}">
                <div style="
                    font-size: 11.5px;
                    font-weight: ${fontWeight};
                    letter-spacing: 0.015em;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    text-align: center;
                    width: 100%;">
                    ${cleanTitle}
                </div>
                ${cleanDesc ? `
                <div style="
                    font-size: 9px;
                    opacity: 0.8;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    text-align: center;
                    width: 100%;
                    margin-top: 1px;">
                    ${cleanDesc}
                </div>` : ''}
            </div>
        `;
    }).join('');

    // End continuation chevron badge
    const endBadge = hasEndContinuation
        ? `<div style="
            flex: 0 0 58px;
            height: 100%;
            margin-left: ${overlapMargin}px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #1f1f23;
            color: #71717a;
            font-size: 10px;
            font-weight: 600;
            clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, ${arrowDepth}px 50%);
            padding-left: ${arrowDepth + 2}px;
            box-sizing: border-box;
            white-space: nowrap;
            position: relative;
            z-index: 1;"
            title="${total - 1 - endIdx} remaining step(s)">+${total - 1 - endIdx} more</div>`
        : '';

    return `
        <div class="chevron-pipeline" style="
            display: flex;
            width: 100%;
            box-sizing: border-box;
            padding: 6px 8px;
            border: 1px solid #27272a;
            border-radius: 8px;
            background: #18181b;
            margin: 4px 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
            <div style="
                display: flex;
                align-items: center;
                width: 100%;
                height: 38px;
                overflow-x: auto;
                box-sizing: border-box;
                padding-bottom: 1px;">
                ${startBadge}
                ${chevronItems}
                ${endBadge}
            </div>
        </div>
    `;
}

async function handler(args, api) {
    const steps = args.steps || [];
    if (steps.length === 0) {
        return "ERROR: Provide at least 1 step.";
    }

    const currentStep = args.current_step || 1;
    const maxVisible = args.max_visible || 6;
    const palette = args.palette || 'emerald';

    // Format header message: "[Title • ]Step X of Y (Active Title)"
    const cleanTitle = removeEmojis(args.title);
    const activeStepObj = steps[Math.min(steps.length - 1, Math.max(0, currentStep - 1))];
    const activeStepTitle = removeEmojis(activeStepObj?.title) || `Step ${currentStep}`;

    const headerMsg = cleanTitle
        ? `${cleanTitle} • Step ${currentStep} of ${steps.length} (${activeStepTitle})`
        : `Step ${currentStep} of ${steps.length} (${activeStepTitle})`;

    // Push title and step progress to the tool header bar
    if (typeof api?.setHeaderMsg === 'function') {
        api.setHeaderMsg(headerMsg);
    }

    const progressHtml = buildChevronPipelineHTML(
        steps,
        currentStep,
        maxVisible,
        palette
    );

    return {
        output: headerMsg,
        displayHtml: progressHtml
    };
}