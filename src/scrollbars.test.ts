import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { launchChromium } from './chromium.js';

test('floating scrollbars keep layout stable, reveal nearby, fade and drag both axes', async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: 'Floating scrollbar test' });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="surface" style="position:absolute;left:100px;top:100px;width:300px;height:150px;overflow:auto;transition:height 300ms linear"><div style="width:600px;height:250px">Content</div></div>');
    await page.addStyleTag({ content: fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(new URL('../public/scrollbars.js', import.meta.url), 'utf8') });
    const surface = page.locator('#surface');
    await page.waitForFunction(() => document.querySelectorAll('.overlay-scrollbar:not([hidden])').length === 2);
    assert.equal(await surface.evaluate(el => el.clientWidth), 300);
    await page.mouse.move(380, 130); // Near the edge, outside the 12px handle.
    await page.waitForFunction(() => document.querySelector('.overlay-scrollbar.vertical')!.classList.contains('active'));
    await page.mouse.move(50, 50);
    await surface.evaluate(el => { el.scrollTop = 30; });
    await page.waitForFunction(() => document.querySelector('.overlay-scrollbar.vertical')!.classList.contains('active'));
    await page.waitForFunction(() => !document.querySelector('.overlay-scrollbar.vertical')!.classList.contains('active'));
    const vertical = await page.locator('.overlay-scrollbar.vertical .overlay-scrollbar-thumb').boundingBox();
    assert.ok(vertical);
    await page.mouse.move(vertical.x + 6, vertical.y + 10);
    await page.mouse.down();
    await page.mouse.move(vertical.x + 6, vertical.y + 45);
    await page.mouse.up();
    assert.ok(await surface.evaluate(el => el.scrollTop) > 50);
    const horizontal = await page.locator('.overlay-scrollbar.horizontal .overlay-scrollbar-thumb').boundingBox();
    assert.ok(horizontal);
    await page.mouse.move(horizontal.x + 10, horizontal.y + 6);
    await page.mouse.down();
    await page.mouse.move(horizontal.x + 80, horizontal.y + 6);
    await page.mouse.up();
    assert.ok(await surface.evaluate(el => el.scrollLeft) > 100);
    // Grow through the overflow threshold. Every animation frame must retain full content width.
    const widths = await surface.evaluate(async el => {
      el.style.height = '350px';
      const widths: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 400) {
        await new Promise(requestAnimationFrame);
        widths.push(el.clientWidth);
      }
      return widths;
    });
    assert.ok(widths.length > 3);
    assert.ok(widths.every(width => width === 300));
    await page.waitForFunction(() => (document.querySelector('.overlay-scrollbar.vertical') as HTMLElement).hidden);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.overlay-scrollbar.horizontal').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  } finally { await browser.close(); }
});

test('floating handles follow dynamic surfaces and disappear behind a modal or on removal', async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: 'Floating scrollbar lifecycle test' });
  try {
    const page = await browser.newPage();
    await page.setContent('<main></main>');
    await page.addStyleTag({ content: fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(new URL('../public/scrollbars.js', import.meta.url), 'utf8') });
    await page.evaluate(() => {
      document.querySelector('main')!.innerHTML = '<textarea aria-label="Text" style="position:absolute;left:100px;top:100px;width:300px;height:100px;overflow:auto">' + 'Line\n'.repeat(50) + '</textarea>';
    });
    await page.waitForFunction(() => document.querySelector('.overlay-scrollbar:not([hidden])'));
    await page.evaluate(() => {
      const modal = document.createElement('div');
      modal.id = 'cover';
      modal.style.cssText = 'position:fixed;inset:0;background:black;z-index:40';
      document.body.append(modal);
    });
    await page.waitForFunction(() => !document.querySelector('.overlay-scrollbar:not([hidden])'));
    await page.locator('#cover').evaluate(el => el.remove());
    await page.waitForFunction(() => document.querySelector('.overlay-scrollbar:not([hidden])'));
    await page.locator('textarea').evaluate(el => { el.setAttribute('hidden', ''); });
    await page.waitForFunction(() => !document.querySelector('.overlay-scrollbar:not([hidden])'));
    await page.locator('textarea').evaluate(el => el.remove());
    await page.waitForFunction(() => !document.querySelector('.overlay-scrollbar'));
  } finally { await browser.close(); }
});

test('streamed text and scrolling update the thumb, and covers inside a surface still hide handles', async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: 'Floating scrollbar quick path test' });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="log" style="position:absolute;left:100px;top:100px;width:300px;height:150px;overflow:auto"><p id="text">x</p></div>'
      + '<div id="side" style="position:absolute;left:500px;top:100px;width:200px;height:150px;overflow:auto"><div style="height:400px"></div></div>');
    await page.addStyleTag({ content: fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(new URL('../public/scrollbars.js', import.meta.url), 'utf8') });
    await page.waitForFunction(() => document.querySelectorAll('.overlay-scrollbar:not([hidden])').length === 1);
    // Grow the text node in place (characterData) until the log overflows.
    await page.evaluate(() => { document.getElementById('text')!.firstChild!.textContent = 'line '.repeat(400); });
    await page.waitForFunction(() => document.querySelectorAll('.overlay-scrollbar.vertical:not([hidden])').length === 2);
    // The log's handle is the one left of the side panel.
    const logThumb = () => [...document.querySelectorAll<HTMLElement>('.overlay-scrollbar.vertical .overlay-scrollbar-thumb')]
      .find(thumb => thumb.getBoundingClientRect().left < 450)!;
    await page.addScriptTag({ content: `window.logThumb = ${logThumb.toString()}` });
    const thumbHeight = () => page.evaluate(() => (window as any).logThumb().offsetHeight);
    const before = await thumbHeight();
    await page.evaluate(() => { document.getElementById('text')!.firstChild!.textContent += ' more'.repeat(800); });
    await page.waitForFunction(old => (window as any).logThumb().offsetHeight < old, before);
    // Scrolling moves only the thumb: the bars are not restyled.
    const barWrites = await page.evaluate(async () => {
      let writes = 0;
      const observer = new MutationObserver(records => { writes += records.filter(r => r.target instanceof HTMLElement && r.target.classList.contains('overlay-scrollbar')).length; });
      document.querySelectorAll('.overlay-scrollbar').forEach(bar => observer.observe(bar, { attributes: true, attributeFilter: ['style'] }));
      const log = document.getElementById('log')!;
      for (let i = 0; i < 10; i++) { log.scrollTop += 20; await new Promise(requestAnimationFrame); }
      observer.disconnect();
      return writes;
    });
    assert.equal(barWrites, 0);
    await page.evaluate(() => { document.getElementById('log')!.scrollTop = 1e6; });
    await page.waitForFunction(() => {
      const thumb = (window as any).logThumb() as HTMLElement;
      return thumb.getBoundingClientRect().bottom > thumb.parentElement!.getBoundingClientRect().bottom - 2;
    });
    // A fixed popup added inside the log covers the side panel's handle.
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;left:450px;top:50px;width:400px;height:300px;background:black;z-index:5';
      document.getElementById('log')!.append(cover);
    });
    await page.waitForFunction(() => document.querySelectorAll('.overlay-scrollbar.vertical:not([hidden])').length === 1);
  } finally { await browser.close(); }
});
