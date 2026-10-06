import { app, startScheduler } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, () => {
  console.log(`Hermesbook backend listening on http://localhost:${PORT}`);
  console.log(`  GET /api/snapshot`);
  console.log(`  GET /api/stream (SSE)`);
  console.log(`  POST /api/fork`);
  console.log(`  GET /api/treasury`);
  console.log(`  GET /api/status`);
});

startScheduler();
