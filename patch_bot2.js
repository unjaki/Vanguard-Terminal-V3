const fs = require('fs');
let b = fs.readFileSync('bot.js', 'utf8');

const importReplacement = `require('dotenv').config();
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\\\n/g, '\\n')
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});
const sheets = google.sheets({ version: 'v4', auth });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let lastProcessedRow = 0;

async function pollPilotSheet() {
    if (!process.env.GOOGLE_SHEET_ID_PILOT || !process.env.ADMIN_DISCORD_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
        return;
    }
    
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SHEET_ID_PILOT,
            range: 'A:Z'
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
            
            const user = await client.users.fetch(process.env.ADMIN_DISCORD_ID);
            
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

const oldImport = `require('dotenv').config();
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

b = b.replace(oldImport, importReplacement);

fs.writeFileSync('bot.js', b);
