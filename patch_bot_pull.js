const fs = require('fs');
let b = fs.readFileSync('bot.js', 'utf8');

const targetRegex = /try \{\s*const response = await axios\.get\(`http:\/\/localhost:3000\/api\/v1\/bot\/forms\?type=\$\{type\}\&newest=\$\{newest\}`,\s*\{\s*headers: \{ 'Authorization': `Bearer \$\{process\.env\.INTERNAL_BOT_API_KEY\}` \}\s*\}\s*\);\s*const forms = response\.data\.forms;/;

const newLogic = `try {
            let spreadsheetId = null;
            if (type === 'pilot') spreadsheetId = process.env.GOOGLE_SHEET_ID_PILOT;
            else if (type === 'gsmc') spreadsheetId = process.env.GOOGLE_SHEET_ID_GSMC;

            if (!spreadsheetId) {
                return await interaction.editReply({ content: '❌ Spreadsheet ID not configured for this type.' });
            }

            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: 'A:Z'
            });

            const rows = response.data.values;
            if (!rows || rows.length <= 1) {
                return await interaction.editReply({ content: '❌ No responses found for that form type.' });
            }

            const headers = rows[0];
            const dataRows = rows.slice(1);
            
            const forms = [];
            for (let i = dataRows.length - 1; i >= 0; i--) {
                const row = dataRows[i];
                const responsesObj = {};
                for (let j = 0; j < headers.length; j++) {
                    responsesObj[headers[j]] = row[j] || 'N/A';
                }
                forms.push({
                    submittedAt: row[0] || new Date().toISOString(),
                    responses: responsesObj
                });
                
                if (newest && forms.length === 1) break;
                if (!newest && forms.length >= 10) break;
            }`;

if (targetRegex.test(b)) {
    b = b.replace(targetRegex, newLogic);
    fs.writeFileSync('bot.js', b);
    console.log('Patched bot.js successfully.');
} else {
    console.log('Regex did not match.');
}
