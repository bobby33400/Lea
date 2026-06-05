'use strict';
/* Generates build/icon.png (used by electron-builder to derive .icns/.ico). */
const path = require('path');
const { writeAppIcon } = require('../src/icon');

const out = path.join(__dirname, '..', 'build', 'icon.png');
writeAppIcon(out, 512);
console.log('wrote', out);
