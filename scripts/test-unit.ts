export {};

const args = Bun.argv.slice(2).filter((a) => a !== "--");
// Without an explicit path, scope discovery to tests/unit so Workers and
// Playwright suites are not picked up by the unit runner.
const hasPath = args.some((a) => !a.startsWith("-"));

const proc = Bun.spawn([process.execPath, "test", ...(hasPath ? [] : ["tests/unit"]), ...args], {
  stdout: "pipe",
  stderr: "pipe",
});

const [out, err, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
process.stdout.write(out);
process.stderr.write(err);

if (code !== 0) {
  process.exit(code);
}
if (/\bRan 0 tests\b/.test(out + err)) {
  console.error("test:unit: selection resolved to zero tests");
  process.exit(1);
}
