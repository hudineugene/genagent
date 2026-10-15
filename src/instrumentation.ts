// При старте сервера: миграции БД, первый администратор (если база пустая), прерванные загрузки,
// Telegram-боты и резервные копии (на сервере).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { db } = await import("./db");
  const { runMigrations } = await import("./db/migrate");
  await runMigrations(db);

  const { users } = await import("./db/schema");
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password && (await db.select({ id: users.id }).from(users).limit(1)).length === 0) {
    const { hashPassword } = await import("./lib/passwords");
    await db.insert(users).values({ email, name: "Администратор", role: "admin", passwordHash: await hashPassword(password) });
    console.log(`Создан первый администратор: ${email}`);
  }

  const { markInterrupted } = await import("./lib/kb/store");
  await markInterrupted();
  // Смысловой поиск: досчитать «отпечатки» для старых фрагментов и заранее загрузить модель (если база знаний не пуста).
  const hasChunks = db.$sqlite.prepare("SELECT 1 FROM kb_chunks LIMIT 1").get();
  if (hasChunks) {
    const { embedQuery, kickEmbeddingWorker } = await import("./lib/kb/embeddings");
    kickEmbeddingWorker();
    void embedQuery("прогрев").catch(() => {});
  }
  const { markInterruptedRuns } = await import("./lib/tests/engine");
  await markInterruptedRuns();
  const { startAllPollers } = await import("./lib/channels/telegram-poller");
  await startAllPollers();
  const { startSocialPolling } = await import("./lib/channels/meta/poller");
  startSocialPolling();
  const { startEmailPolling } = await import("./lib/channels/email");
  startEmailPolling();
  const { startNotifyPolling } = await import("./lib/notify/telegram");
  startNotifyPolling();
  const { startGapsAnalysis } = await import("./lib/agent/gaps");
  startGapsAnalysis();
  const { startWeeklyTests } = await import("./lib/tests/weekly");
  startWeeklyTests();
  const { startDailyDigest } = await import("./lib/agent/daily");
  startDailyDigest();
  const { startWeeklyReview } = await import("./lib/agent/review");
  startWeeklyReview();
  const { startMonthlyReports } = await import("./lib/agent/report");
  startMonthlyReports();
  const { startWatch } = await import("./lib/agent/watch");
  startWatch();
  // Клиент ждёт ответа человека — напоминания в Telegram
  const { startWaitingReminders } = await import("./lib/agent/waiting");
  startWaitingReminders();
  const { startFollowUps } = await import("./lib/agent/followups");
  startFollowUps();
  const { startMemory } = await import("./lib/agent/memory");
  startMemory();

  if (process.env.BACKUP_DIR) {
    const { startBackups } = await import("./lib/backup");
    startBackups(process.env.BACKUP_DIR);
  }
}
