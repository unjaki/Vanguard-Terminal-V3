const puppeteer = require('puppeteer');
const express = require('express');
const app = express();
app.use(express.static('public'));
const server = app.listen(3333, async () => {
    try {
        const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', err => {
            console.log('PAGE ERROR:', err.toString());
        });
        
        await page.goto('http://localhost:3333/', { waitUntil: 'networkidle0' });
        await browser.close();
        server.close();
    } catch(e) { console.error(e); server.close(); }
});
