const fs = require('fs');
let b = fs.readFileSync('bot.js', 'utf8');

const importReplacement = `require('dotenv').config();
const { google } = require('googleapis');
const sheets = google.sheets('v4');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let lastProcessedRow = 0;

async function pollPilotSheet() {
    if (!process.env.GOOGLE_SHEET_ID_PILOT || !process.env.GOOGLE_SHEETS_API_KEY || !process.env.DISCORD_OWNER_ID) {
        return;
    }
    
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID_PILOT,
            range: 'A:Z',
            key: process.env.GOOGLE_SHEETS_API_KEY
        });
        
        const rows = response.data.values;
        if (!rows || rows.length === 0) return;
        
        if (lastProcessedRow === 0) {
            lastProcessedRow = rows.length;
            return;
        }
        
        if (rows.length > lastProcessedRow) {
            const newRows = rows.slice(lastProcessedRow);
            const headers = rows[0] || [];
            
            const user = await client.users.fetch(process.env.DISCORD_OWNER_ID);
            
            for (const row of newRows) {
                let msg = '🚨 **New Pilot Form Response** 🚨\\n\\n';
                for (let i = 0; i < headers.length; i++) {
                    msg += '**' + headers[i] + '**: ' + (row[i] || 'N/A') + '\\n';
                }
                
                await user.send(msg.substring(0, 2000)).catch(err => console.error('[BOT] Failed to DM owner', err));
            }
            
            lastProcessedRow = rows.length;
        }
    } catch (err) {
        console.error('[BOT] Error polling Google Sheet:', err.message);
    }
}`;

b = b.replace(/require\('dotenv'\)\.config\(\);\s*const client = new Client\(\{ intents: \[GatewayIntentBits\.Guilds\] \}\);/, importReplacement);

const readyReplacement = `client.once('ready', async () => {
    console.log(\`[BOT] Logged in as \${client.user.tag}!\`);

    setInterval(pollPilotSheet, 30000);
    pollPilotSheet();

    // Register slash commands (Global registration)`;

b = b.replace(/client\.once\('ready', async \(\) => \{\s*console\.log\(\`\[BOT\] Logged in as \$\{client\.user\.tag\}!\`\);\s*\/\/ Register slash commands \(Global registration\)/, readyReplacement);

fs.writeFileSync('bot.js', b);
