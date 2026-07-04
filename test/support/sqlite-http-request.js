const url = process.argv[2];

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input,
    });
    const payload = await response.json();
    process.stdout.write(JSON.stringify(payload));
    process.exit(response.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  }
});
