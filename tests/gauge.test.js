// Geometry checks for helpers/gauge.js. Run with:
//   gjs -m tests/gauge.test.js
//
// The gauge is rendered with cairo on a black background: the track shows up
// as grey, the fill as red, and the antialiased green channel lets us measure
// the exact fill length in pixels.

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import cairo from 'cairo';
import system from 'system';

import {drawBattery} from '../helpers/gauge.js';

const FILL = [1, 0, 0, 1];
const EPSILON = 0.4;

let failures = 0;
let serial = 0;
const TMP_DIR = GLib.dir_make_tmp('vitals-gauge-XXXXXX');

function render(width, height, value, vertical) {
    let surface = new cairo.ImageSurface(cairo.Format.ARGB32, width, height);
    let cr = new cairo.Context(surface);
    cr.setSourceRGBA(0, 0, 0, 1);
    cr.paint();
    drawBattery(cr, width, height, value, FILL, vertical);
    cr.$dispose();
    surface.flush();

    // the gjs cairo binding has no pixel access, so round-trip through a PNG
    let path = GLib.build_filenamev([TMP_DIR, `render-${serial++}.png`]);
    surface.writeToPNG(path);
    let pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    return { pixbuf, width, height };
}

function pixel(image, x, y) {
    let data = image.pixbuf.get_pixels();
    let channels = image.pixbuf.get_n_channels();
    let offset = y * image.pixbuf.get_rowstride() + x * channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
}

// Fraction of the pixel covered by the fill. The track is neutral grey and
// the fill is pure red, so red minus green isolates the fill coverage.
function coverage(image, x, y) {
    let [red, green] = pixel(image, x, y);
    return Math.max(0, Math.min(1, (red - green) / 255));
}

function fillLength(image, vertical) {
    let length = 0;
    if (vertical) {
        let x = Math.floor(image.width / 2);
        for (let y = 0; y < image.height; y++)
            length += coverage(image, x, y);
    } else {
        let y = Math.floor(image.height / 2);
        for (let x = 0; x < image.width; x++)
            length += coverage(image, x, y);
    }
    return length;
}

function check(name, actual, expected) {
    let ok = Math.abs(actual - expected) <= EPSILON;
    if (!ok) {
        failures++;
        printerr(`FAIL ${name}: got ${actual.toFixed(2)}px, want ${expected.toFixed(2)}px`);
    } else {
        print(`ok   ${name}: ${actual.toFixed(2)}px`);
    }
}

function checkDark(name, image, x, y) {
    let [red] = pixel(image, x, y);
    if (red > 90) {
        failures++;
        printerr(`FAIL ${name}: pixel (${x},${y}) painted outside the track`);
    } else {
        print(`ok   ${name}: (${x},${y}) is outside the fill`);
    }
}

// Vertical gauge: 14px tall, 8px wide, fill from the bottom
const V_W = 10, V_H = 14;
check('vertical 13% is 1.8px', fillLength(render(V_W, V_H, 0.13, true), true), V_H * 0.13);
check('vertical 50% is 7px', fillLength(render(V_W, V_H, 0.5, true), true), V_H * 0.5);
check('vertical 100% is 14px', fillLength(render(V_W, V_H, 1, true), true), V_H);
check('vertical 0% is empty', fillLength(render(V_W, V_H, 0, true), true), 0);

// Horizontal gauge: 34px wide, 10px bar, fill from the left
const H_W = 34, H_H = 14;
check('horizontal 8% is 2.7px', fillLength(render(H_W, H_H, 0.08, false), false), H_W * 0.08);
check('horizontal 60% is 20.4px', fillLength(render(H_W, H_H, 0.6, false), false), H_W * 0.6);
check('horizontal 100% is 34px', fillLength(render(H_W, H_H, 1, false), false), H_W);

// A tiny reading stays visible but must not leak out of the rounded track
let tiny = render(V_W, V_H, 0.004, true);
check('vertical tiny reading is 1px', fillLength(tiny, true), 1);
checkDark('vertical tiny reading corner left', tiny, 1, 13);
checkDark('vertical tiny reading corner right', tiny, 8, 13);

if (failures > 0) {
    printerr(`${failures} gauge check(s) failed`);
    system.exit(1);
}
print('all gauge checks passed');
