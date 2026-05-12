const { chromium } = require('playwright');
(async() => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const urls = ['https://shop.blun.ai/','https://send.blun.ai/'];
  const results = [];
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const footer = page.locator('footer[data-shared-chrome="blun-footer"]');
    await footer.scrollIntoViewIfNeeded();
    const box = await footer.boundingBox();
    const text = await footer.innerText();
    const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    const shot = `/tmp/${new URL(url).host.replace(/\./g,'_')}-mobile-footer.png`;
    await page.screenshot({ path: shot, fullPage: true });
    results.push({ url, viewport: '390x844', footerFound: !!box, footerBox: box, hasProducts: text.includes('BLUN Products'), hasShopping: text.includes('Shopping'), hasMailing: text.includes('Mailing'), overflow, screenshot: shot });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const footer = page.locator('footer[data-shared-chrome="blun-footer"]');
    await footer.scrollIntoViewIfNeeded();
    const box = await footer.boundingBox();
    const text = await footer.innerText();
    const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    const shot = `/tmp/${new URL(url).host.replace(/\./g,'_')}-desktop-footer.png`;
    await page.screenshot({ path: shot, fullPage: true });
    results.push({ url, viewport: '1440x900', footerFound: !!box, footerBox: box, hasProducts: text.includes('BLUN Products'), hasShopping: text.includes('Shopping'), hasMailing: text.includes('Mailing'), overflow, screenshot: shot });
  }
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
