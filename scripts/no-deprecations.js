// Loaded into every test process (`node --import`): a test file that makes inkan print a
// deprecation warning fails, so the packages stay on the current names. inkan says it once
// per process through console.warn, as "inkan: <name> is deprecated, use <name>. …".

const warn = console.warn;
const seen = [];

console.warn = (...args) => {
  const text = args.map(String).join(" ");
  if (/^inkan: .* is deprecated, use /.test(text)) seen.push(text);
  warn.apply(console, args);
};

process.on("exit", () => {
  if (seen.length === 0) return;
  process.stderr.write(`\n${seen.length} deprecation warning(s) from inkan:\n${seen.map((s) => `  ${s}`).join("\n")}\n`);
  process.exitCode = 1;
});
