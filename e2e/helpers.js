/** Seed demo mode so tests don't need real Supabase credentials */
export async function seedDemoMode(page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("nomad-demo-mode", "true");
    localStorage.removeItem("nomad-credentials");
  });
  await page.reload();
  // Wait for app to load demo data
  await page.waitForSelector("text=Demo Mode", { timeout: 10000 });
}
