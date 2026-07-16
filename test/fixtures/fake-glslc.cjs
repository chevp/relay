#!/usr/bin/env node
// Stand-in for glslc in tests — writes a marker file instead of real SPIR-V,
// so shaderCompile tests don't depend on a Vulkan SDK install.
const fs = require('node:fs');

const args = process.argv.slice(2);
const outIdx = args.indexOf('-o');
if (outIdx === -1 || !args[outIdx + 1]) {
  process.stderr.write('fake-glslc: missing -o <output>\n');
  process.exit(1);
}
const src = args[0];
const out = args[outIdx + 1];
if (process.env.FAKE_GLSLC_FAIL) {
  process.stderr.write('fake-glslc: forced failure\n');
  process.exit(1);
}
fs.writeFileSync(out, `FAKE_SPV_OF(${fs.readFileSync(src, 'utf8')})`);
process.exit(0);
