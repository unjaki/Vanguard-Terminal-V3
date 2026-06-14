const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    page.on('dialog', async dialog => {
        console.log('ALERT:', dialog.message());
        await dialog.dismiss();
    });
    
    await page.goto('http://localhost:3000');
    console.log("Loaded page");
    
    // Attempt to evaluate executeTokenGeneration
    await page.evaluate(async () => {
        // Mock the values
        let tokenModal = document.getElementById('token-modal');
        if (!tokenModal) {
            console.log("No token modal!"); 
        }
        document.getElementById('token-target-user').value = 'TestUser';
        document.getElementById('token-tier-level').value = '2';
        document.getElementById('override-key-input').value = 'VERITAS EST QUOD SERVATUR';
        await executeTokenGeneration();
    });
    
    const resultText = await page.evaluate(() => document.getElementById('token-result-box').innerText);
    const resultDisplay = await page.evaluate(() => document.getElementById('token-result-box').style.display);
    console.log("Result Box Display:", resultDisplay);
    console.log("Result Box Text:", resultText);
    
    await browser.close();
})();
