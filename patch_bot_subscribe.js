const fs = require('fs');
let b = fs.readFileSync('bot.js', 'utf8');

// 1. Add subscribe command definition
const subscribeCommandDef = `
// The /subscribe command definition
const subscribeCommand = new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Toggle your subscription to new form responses.')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
    .addStringOption(option =>
        option.setName('form')
            .setDescription('Which form to subscribe/unsubscribe to')
            .setRequired(true)
            .addChoices(
                { name: 'Pilot', value: 'pilot' },
                { name: 'GSMC', value: 'gsmc' }
            )
    );
`;

b = b.replace(/\/\/ The \/link command definition/, subscribeCommandDef + '\n// The /link command definition');

// 2. Add subscribe command to the array
b = b.replace(/const commands = \[linkCommand\.toJSON\(\), searchCommand\.toJSON\(\), generateCommand\.toJSON\(\), pullResponsesCommand\.toJSON\(\)\];/, 
    'const commands = [linkCommand.toJSON(), searchCommand.toJSON(), generateCommand.toJSON(), pullResponsesCommand.toJSON(), subscribeCommand.toJSON()];');

// 3. Add handler logic
const subscribeHandler = `
    } else if (interaction.commandName === 'subscribe') {
        const formType = interaction.options.getString('form');
        const discordId = interaction.user.id;
        
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        try {
            // Check registration gate
            const userRes = await axios.get(\`http://localhost:3000/api/v1/bot/user/\${discordId}\`, {
                headers: { 'Authorization': \`Bearer \${process.env.INTERNAL_BOT_API_KEY}\` }
            });
            
            const userData = userRes.data;
            if (!userData) {
                return await interaction.editReply({ content: '❌ Registration Gate Failed: You are not linked in the internal database.' });
            }
            
            // Tier gate check (Tier >= 4 or Admin)
            if (userData.tier < 4 && discordId !== process.env.ADMIN_DISCORD_ID) {
                return await interaction.editReply({ content: \`❌ Tier Gate Failed: Required Tier 4, your current tier is \${userData.tier}.\` });
            }
            
            // Read/Edit text file
            const subsFile = 'subscriptions.json';
            let subs = { pilot: [], gsmc: [] };
            if (fs.existsSync(subsFile)) {
                try {
                    subs = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
                } catch(e) {}
            }
            
            if (!subs[formType]) subs[formType] = [];
            
            let actionStr = '';
            if (subs[formType].includes(discordId)) {
                subs[formType] = subs[formType].filter(id => id !== discordId);
                actionStr = 'Unsubscribed from';
            } else {
                subs[formType].push(discordId);
                actionStr = 'Subscribed to';
            }
            
            fs.writeFileSync(subsFile, JSON.stringify(subs, null, 2));
            
            await interaction.editReply({ content: \`✅ \${actionStr} \${formType.toUpperCase()} notifications successfully.\` });
            
        } catch (error) {
            console.error('[BOT] Error in /subscribe:', error?.response?.data || error.message);
            if (error.response && error.response.status === 404) {
                await interaction.editReply({ content: '❌ Registration Gate Failed: You are not linked in the internal database.' });
            } else {
                await interaction.editReply({ content: '❌ An error occurred processing your subscription.' });
            }
        }
`;

b = b.replace(/\} else if \(interaction\.commandName === 'pull_responses'\) \{/, subscribeHandler + "} else if (interaction.commandName === 'pull_responses') {");

// 4. Update the polling logic
const pollLogic = `
const fsMod = require('fs');
let lastProcessedRow = { pilot: 0, gsmc: 0 };

function getSubscribers(formType) {
    const subsFile = 'subscriptions.json';
    if (fsMod.existsSync(subsFile)) {
        try {
            const subs = JSON.parse(fsMod.readFileSync(subsFile, 'utf8'));
            if (subs[formType] && subs[formType].length > 0) {
                return subs[formType];
            }
        } catch(e) {}
    }
    return process.env.ADMIN_DISCORD_ID ? [process.env.ADMIN_DISCORD_ID] : [];
}

async function pollSheet(type, spreadsheetId) {
    if (!spreadsheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) return;
    
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'A:Z'
        });
        
        const rows = response.data.values;
        if (!rows || rows.length === 0) return;
        
        if (lastProcessedRow[type] === 0) {
            lastProcessedRow[type] = rows.length;
            return;
        }
        
        if (rows.length > lastProcessedRow[type]) {
            const newRows = rows.slice(lastProcessedRow[type]);
            const headers = rows[0] || [];
            
            const subscribers = getSubscribers(type);
            
            for (const row of newRows) {
                let msg = \`🚨 **New \${type.toUpperCase()} Form Response** 🚨\\n\\n\`;
                for (let i = 0; i < headers.length; i++) {
                    msg += '**' + headers[i] + '**: ' + (row[i] || 'N/A') + '\\n';
                }
                
                for (const subId of subscribers) {
                    try {
                        const user = await client.users.fetch(subId);
                        if (user) await user.send(msg.substring(0, 2000));
                    } catch(e) {
                        console.error(\`[BOT] Failed to DM \${subId}\`, e.message);
                    }
                }
            }
            
            lastProcessedRow[type] = rows.length;
        }
    } catch (err) {
        console.error(\`[BOT] Error polling \${type} Google Sheet:\`, err.message);
    }
}

async function pollAllSheets() {
    await pollSheet('pilot', process.env.GOOGLE_SHEET_ID_PILOT);
    await pollSheet('gsmc', process.env.GOOGLE_SHEET_ID_GSMC);
}
`;

// Replace `let lastProcessedRow = 0; ... async function pollPilotSheet() { ... }`
b = b.replace(/let lastProcessedRow = 0;[\s\S]*?async function pollPilotSheet\(\) \{[\s\S]*?\}\n\}/, pollLogic);

// Replace `setInterval(pollPilotSheet, 30000); pollPilotSheet();`
b = b.replace(/setInterval\(pollPilotSheet, 30000\);\s*pollPilotSheet\(\);/g, "setInterval(pollAllSheets, 30000);\n    pollAllSheets();");

fs.writeFileSync('bot.js', b);
