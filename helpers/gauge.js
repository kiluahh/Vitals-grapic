// Battery-style panel gauges: a rounded track with a proportional fill.
//
// The fill is exactly `value` of the gauge length, so a 13% reading paints 13%
// of the track. Tiny readings get one pixel so a non-empty gauge never looks
// empty, and every fill is clipped to the track so it cannot spill out of the
// rounded ends. Kept free of St/Clutter so the geometry can be rendered and
// checked with plain cairo (see tests/gauge.test.js).

const TRACK_RGBA = [0.5, 0.5, 0.5, 0.28];
const MIN_FILL = 1;   // logical px, keeps a hairline of charge visible

function roundRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.arc(x + w - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
    cr.arc(x + w - r, y + h - r, r, 0, 0.5 * Math.PI);
    cr.arc(x + r, y + h - r, r, 0.5 * Math.PI, Math.PI);
    cr.closePath();
}

function drawHorizontal(cr, width, height, value, color) {
    let barHeight = Math.min(height, 10);
    let y = (height - barHeight) / 2;
    let radius = barHeight / 2;

    cr.setSourceRGBA(...TRACK_RGBA);
    roundRect(cr, 0, y, width, barHeight, radius);
    cr.fill();

    if (value > 0) {
        let fillWidth = Math.min(width, Math.max(MIN_FILL, width * value));
        cr.save();
        roundRect(cr, 0, y, width, barHeight, radius);
        cr.clip();
        cr.setSourceRGBA(...color);
        roundRect(cr, 0, y, fillWidth, barHeight, radius);
        cr.fill();
        cr.restore();
    }
}

function drawVertical(cr, width, height, value, color) {
    let barWidth = Math.min(width, 8);
    let x = (width - barWidth) / 2;
    let radius = barWidth / 2;

    cr.setSourceRGBA(...TRACK_RGBA);
    roundRect(cr, x, 0, barWidth, height, radius);
    cr.fill();

    if (value > 0) {
        let fillHeight = Math.min(height, Math.max(MIN_FILL, height * value));
        cr.save();
        roundRect(cr, x, 0, barWidth, height, radius);
        cr.clip();
        cr.setSourceRGBA(...color);
        roundRect(cr, x, height - fillHeight, barWidth, fillHeight, radius);
        cr.fill();
        cr.restore();
    }
}

/**
 * Draw a horizontal or vertical battery gauge.
 *
 * @param {cairo.Context} cr - cairo context in logical pixels
 * @param {number} width - gauge width in logical pixels
 * @param {number} height - gauge height in logical pixels
 * @param {number} value - reading, 0..1
 * @param {number[]} color - fill colour as [r, g, b, a]
 * @param {boolean} vertical - vertical (filled from the bottom) or horizontal
 */
export function drawBattery(cr, width, height, value, color, vertical) {
    value = Math.max(0, Math.min(1, value));
    if (vertical)
        drawVertical(cr, width, height, value, color);
    else
        drawHorizontal(cr, width, height, value, color);
}
