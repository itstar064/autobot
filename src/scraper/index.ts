import { delay, isEmpty } from "@/utils";
import { connect, PageWithCursor } from "puppeteer-real-browser";
import config from "@/config";
import processScrapedJob from "@/job.controller";
import { existsSync, mkdirSync } from "fs";

let scraping = false;
const searchUrls = [
  "https://crowdworks.jp/public/jobs/search?category_id=226&order=new",
  "https://crowdworks.jp/public/jobs/search?category_id=311&order=new",
  "https://crowdworks.jp/public/jobs/search?category_id=242&order=new",
  "https://crowdworks.jp/public/jobs/search?category_id=230&order=new",
];

export const useRealBrowser = async () => {
  try {
    const { browser, page } = await connect({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
      customConfig: {},
      turnstile: true,
      connectOption: {
        protocolTimeout: 100000, // set to 60 seconds or whatever you need
      },
      disableXvfb: false,
      ignoreAllFlags: false,
    });

    return { browser, page };
  } catch (err) {
    console.error("Error in useRealBrowser:", (err as Error).message);
    throw err;
  }
};

export const login = async (page: PageWithCursor) => {
  try {
    await page.goto("https://crowdworks.jp/login", {
      waitUntil: "domcontentloaded",
    });

    await page.type('input[name="username"]', config.EMAIL, { delay: 150 });

    await page.type('input[name="password"]', config.PASSWORD, { delay: 150 });

    await page.click('button[type="submit"]');
    console.log("🔓 Submitted login form");
  } catch (err) {
    console.error("Error in login:", (err as Error).message);
    throw err;
  }
};

export async function scrapeJobs() {
  let iteration = 0;
  const RESTART_BROWSER_EVERY = 100; // Restart browser every 100 cycles to avoid memory leaks

  let browser: Awaited<ReturnType<typeof useRealBrowser>>["browser"] | null =
    null;
  let page: Awaited<ReturnType<typeof useRealBrowser>>["page"] | null = null;

  while (true) {
    if (!scraping) {
      try {
        if (page) await page.close().catch(() => {});
      } catch (err) {
        console.error("Error closing page:", (err as Error).message);
      }
      try {
        if (browser) await browser.close().catch(() => {});
      } catch (err) {
        console.error("Error closing browser:", (err as Error).message);
      }
    }

    try {
      // Restart browser every N iterations or if not initialized
      if (iteration % RESTART_BROWSER_EVERY === 0 || !browser || !page) {
        console.log("♻️ Restarting browser to free resources...");
        try {
          if (page) await page.close().catch(() => {});
        } catch (err) {
          console.error("Error closing page:", (err as Error).message);
        }
        try {
          if (browser) await browser.close().catch(() => {});
        } catch (err) {
          console.error("Error closing browser:", (err as Error).message);
        }
        let realBrowser;
        try {
          realBrowser = await useRealBrowser();
        } catch (err) {
          console.error("Error creating real browser:", (err as Error).message);
          await delay(5000);
          continue;
        }
        browser = realBrowser.browser;
        page = realBrowser.page;
        iteration = 0;

        try {
          await page!.setViewport({ width: 1220, height: 860 });
        } catch (err) {
          console.error("Error setting viewport:", (err as Error).message);
        }
        try {
          await login(page!);
        } catch (err) {
          console.error("Error during login:", (err as Error).message);
          await delay(2000);
          continue;
        }

        await delay(5000);
      }
      iteration++;

      if (!scraping) break;
      try {
        const searchUrl = searchUrls[iteration % 4];

        if (isEmpty(searchUrl)) continue;

        try {
          await page!.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
        } catch (err) {
          console.error(
            "Error navigating to searchUrl:",
            (err as Error).message,
          );
          continue;
        }
        const MAX_RETRIES = 30;
        let jobs = [];

        //After page title is found, try to scrape with retries
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            // Wait for at least one job card to appear
            const jobCards = await page!.$$("li[data-v-b9db952a]");
            if (jobCards.length === 0) {
              console.log(
                `🕵️ Waiting for job cards... (${attempt + 1}/${MAX_RETRIES})`,
              );
              await delay(1000);
              continue;
            }

            // Ensure the screenshots directory exists before saving the screenshot
            const screenshotsDir = `${process.cwd()}/screenshots`;
            if (!existsSync(screenshotsDir)) {
              mkdirSync(screenshotsDir, { recursive: true });
            }
            await page.screenshot({
              path: `${screenshotsDir}/job_cards.png`,
            });

            jobs = await page!.evaluate(() => {
              // Select all job card elements
              const cardNodes = document.querySelectorAll(
                "li[data-v-b9db952a]",
              );
              const results: any[] = [];

              cardNodes.forEach((card) => {
                // Title and URL
                const titleAnchor = card.querySelector("h3 a");
                const title = titleAnchor?.textContent?.trim() || "";
                const url = titleAnchor
                  ? `https://crowdworks.jp${titleAnchor.getAttribute("href")}`
                  : "";

                // Description
                const desc =
                  card.querySelector("p.JrrVy")?.textContent?.trim() || "";

                // Category
                const category =
                  card.querySelector("a.KkxIA")?.textContent?.trim() || "";

                // Price (reward)
                const price =
                  card.querySelector("div.AIu_G")?.textContent?.trim() ||
                  card.querySelector("div.zTNhw")?.textContent?.trim();

                // Number of suggestions/items
                // Number of contracts
                const contracts =
                  card.querySelector("b.D0ZNl")?.textContent?.trim() || "";

                // Number of applicants
                const suggestionsText =
                  card.querySelector("span.isfmE")?.textContent?.trim() || "";
                // Extract number from text like "(Number of applicants: 3 people)"
                const suggestionsMatch = suggestionsText.match(/(\d+)/);
                const suggestions = `${contracts}/${suggestionsMatch ? suggestionsMatch[1] : ""}`;

                // Days left
                const daysLeft =
                  card
                    .querySelector("b.GQEZv span.SWhi6")
                    ?.textContent?.trim() || "";

                // Deadline (date string)
                const deadline =
                  card
                    .querySelector("span.mcb6F")
                    ?.textContent?.replace(/[()]/g, "")
                    .trim() || "";

                // Posted date
                const postedDate =
                  card.querySelector("div.nOvaf time")?.textContent?.trim() ||
                  "";

                // Employer name and profile URL
                const employerAnchor = card.querySelector("a.uxHdW");
                const employer = employerAnchor?.textContent?.trim() || "";
                const employerUrl = employerAnchor
                  ? `https://crowdworks.jp${employerAnchor.getAttribute("href")}`
                  : "";

                // Employer avatar
                const employerAvatar =
                  card
                    .querySelector('a[target="_blank"] img')
                    ?.getAttribute("src") || "";

                results.push({
                  title,
                  url,
                  desc,
                  category,
                  price,
                  suggestions,
                  daysLeft,
                  deadline,
                  postedDate,
                  employer,
                  employerUrl,
                  employerAvatar,
                });
              });

              return results;
            });

            break;
          } catch (err) {
            console.error(
              `⚠️ Error during scrape attempt ${attempt + 1}:`,
              err,
            );
            continue;
          }
        }

        if (jobs.length === 0) {
          console.log("❌ Failed to scrape jobs after multiple attempts.");
        } else {
          console.log("✅ Scraped jobs", jobs.length);
        }

        try {
          console.log(jobs);
          processScrapedJob(config.ADMIN_ID, jobs.reverse());
        } catch (err) {
          console.error("Error in processScrapedJob:", (err as Error).message);
        }
        await delay(30000);
      } catch (err) {
        console.error("Error in user scraping loop:", (err as Error).message);
        continue;
      }
    } catch (err) {
      console.error("Error in scrapeJobs loop:", (err as Error).message);
    }
    // No longer close browser/page here; handled by restart logic above
  }
}

export const startScraping = async () => {
  try {
    scraping = true;
    await scrapeJobs();
  } catch (error) {
    console.error(
      "Error occurred while scraping jobs:",
      (error as Error).message,
    );
  }
};

export const stopScraping = () => {
  scraping = false;
};

export const getScrapingStatus = () => {
  return scraping;
};
