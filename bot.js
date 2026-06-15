const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType, MessageFlags } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// The /link command definition
const linkCommand = new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your web profile using an admin token.')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
    .addStringOption(option =>
        option.setName('token')
            .setDescription('The admin-generated alphanumeric security token')
            .setRequired(true)
    )
    .addBooleanOption(option =>
        option.setName('visible')
            .setDescription('Make the response visible to everyone (defaults to false)')
            .setRequired(false)
    );

// The /search command definition
const searchCommand = new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search the personnel or group intel database.')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
    .addStringOption(option =>
        option.setName('type')
            .setDescription('Type of search')
            .setRequired(true)
            .addChoices(
                { name: 'Personnel', value: 'personnel' },
                { name: 'Group Intel', value: 'group intel' }
            )
    )
    .addStringOption(option =>
        option.setName('scope')
            .setDescription('Scope to filter by')
            .setRequired(true)
            .addChoices(
                { name: 'CBRN', value: 'CBRN' },
                { name: 'GSMC', value: 'GSMC' },
                { name: 'NS', value: 'NS' },
                { name: 'ALL', value: 'ALL' },
                { name: 'General', value: 'General' },
                { name: 'Field Ops', value: 'Field Ops' }
            )
    )
    .addStringOption(option =>
        option.setName('roblox_username')
            .setDescription('Roblox username to search (for personnel)')
            .setRequired(false)
    )
    .addStringOption(option =>
        option.setName('group_id')
            .setDescription('Group ID to search (for group intel)')
            .setRequired(false)
    );

// The /generate command definition
const generateCommand = new SlashCommandBuilder()
    .setName('generate')
    .setDescription('Generate an activation token (Admin Only)')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
    .addStringOption(option =>
        option.setName('override_key')
            .setDescription('The admin override key required to generate tokens')
            .setRequired(true)
    )
    .addStringOption(option =>
        option.setName('target_user')
            .setDescription('The targeted profile username to link with')
            .setRequired(true)
    )
    .addIntegerOption(option =>
        option.setName('assigned_tier')
            .setDescription('The Tier Level (1-5) to assign')
            .setRequired(true)
            .addChoices(
                { name: 'Tier 1', value: 1 },
                { name: 'Tier 2', value: 2 },
                { name: 'Tier 3', value: 3 },
                { name: 'Tier 4', value: 4 },
                { name: 'Tier 5', value: 5 }
            )
    )
    .addStringOption(option =>
        option.setName('scope')
            .setDescription('The Unit Scope to assign (e.g. CBRN, GSMC, NS, ALL)')
            .setRequired(true)
            .addChoices(
                { name: 'CBRN', value: 'CBRN' },
                { name: 'GSMC', value: 'GSMC' },
                { name: 'NS', value: 'NS' },
                { name: 'ALL', value: 'ALL' },
                { name: 'General', value: 'General' },
                { name: 'Field Ops', value: 'Field Ops' }
            )
    );

client.once('ready', async () => {
    console.log(`[BOT] Logged in as ${client.user.tag}!`);

    // Register slash commands (Global registration)
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        console.log('[BOT] Started refreshing application (/) commands.');

        const commands = [linkCommand.toJSON(), searchCommand.toJSON(), generateCommand.toJSON()];

        // Ensure DISCORD_CLIENT_ID is provided, fallback to client.user.id
        const clientId = process.env.DISCORD_CLIENT_ID || client.user.id;

        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands }
        );

        console.log('[BOT] Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('[BOT] Error refreshing commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'link') {
        const token = interaction.options.getString('token');
        const visible = interaction.options.getBoolean('visible') ?? false;

        // Immediately defer the reply to prevent the 3-second Discord timeout
        // Make it ephemeral unless 'visible' is set to true
        await interaction.deferReply({ flags: !visible ? MessageFlags.Ephemeral : undefined });

        try {
            // Make internal API call to link Discord account
            const response = await axios.post('http://localhost:3000/api/v1/link-discord', 
                {
                    token: token,
                    discordId: interaction.user.id
                },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.INTERNAL_BOT_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            // Access response data
            const { username, newTier, temporaryPassword } = response.data;

            // Reply indicating success
            await interaction.editReply({ 
                content: `✅ Account successfully linked! Welcome, **${username}**. Your tier has been upgraded to **Tier ${newTier}**.${temporaryPassword ? `\n\n**Temporary Web Password:** \`${temporaryPassword}\`\n(Please use this to log into the web terminal immediately.)` : ''}` 
            });

        } catch (error) {
            console.error('[BOT] API Error during /link:', error?.response?.data || error.message);
            
            // Handle different HTTP status codes explicitly
            if (error.response) {
                const status = error.response.status;
                const message = error.response.data?.error || 'An unknown error occurred.';

                if (status === 401) {
                    await interaction.editReply({ content: '❌ Internal API Authorization failed.' });
                } else if (status === 404) {
                    await interaction.editReply({ content: `❌ Link failed: ${message}` });
                } else if (status === 400) {
                    await interaction.editReply({ content: `❌ Link failed: ${message}` });
                } else if (status === 409) {
                    await interaction.editReply({ content: `❌ Conflict: ${message}` });
                } else {
                    await interaction.editReply({ content: `❌ Error: ${message}` });
                }
            } else {
                // Network drop or total failure
                await interaction.editReply({ content: '❌ Could not contact the linking server. Please try again later.' });
            }
        }
    } else if (interaction.commandName === 'search') {
        const type = interaction.options.getString('type');
        const roblox_username = interaction.options.getString('roblox_username');
        const scope = interaction.options.getString('scope');
        const group_id = interaction.options.getString('group_id');

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            let responseMsg = `🔎 **Search Initiated: ${type.toUpperCase()} | Scope: ${scope}**\n\n`;

            const SCOPES = {
                'GSMC': '288142915',
                'CBRN': '423217030',
                'NS': '1008942731',
                'ALL': '288142915', // fallback to GSMC for ALL
                'General': '288142915',
                'Field Ops': '288142915'
            };

            const targetGroupId = group_id || SCOPES[scope] || '288142915';

            if (type === 'personnel') {
                if (!roblox_username) {
                    await interaction.editReply({ content: '❌ You must provide a `roblox_username` when searching for personnel.' });
                    return;
                }
                
                try {
                    const response = await axios.get(`http://localhost:3000/verify-member/${targetGroupId}/${encodeURIComponent(roblox_username)}`, {
                        headers: { 'Authorization': `Bearer ${process.env.INTERNAL_BOT_API_KEY}` }
                    });
                    
                    const data = response.data;
                    responseMsg += `👤 **${data.officer}** | Rank: ${data.rank || 'N/A'}\n`;
                    responseMsg += `Status: ${data.status} | Sync: ${data.syncEnabled ? 'ENABLED' : 'DISABLED'}`;
                } catch (err) {
                    if (err.response && err.response.status === 404) {
                        responseMsg += `*Personnel not found in target unit or name typo.*`;
                    } else {
                        throw err;
                    }
                }
            } else if (type === 'group intel') {
                try {
                    const response = await axios.get(`http://localhost:3000/group-info/${targetGroupId}`, {
                        headers: { 
                            'Authorization': `Bearer ${process.env.INTERNAL_BOT_API_KEY}`,
                            'x-group-scope': scope
                        }
                    });
                    
                    const data = response.data;
                    responseMsg += `🛡️ **${data.name}** (ID: ${data.id})\n`;
                    responseMsg += `Owner: ${data.owner?.username || 'UNKNOWN'}\n`;
                    responseMsg += `Members: ${data.memberCount || 0}\n`;
                } catch (err) {
                    if (err.response && err.response.status === 404) {
                        responseMsg += `*Group not found or uplink error.*`;
                    } else {
                        throw err;
                    }
                }
            }

            await interaction.editReply({ content: responseMsg });

        } catch (error) {
            console.error('[BOT] API Error during /search:', error?.response?.data || error.message);
            await interaction.editReply({ content: '❌ An error occurred while executing the search.' });
        }
    } else if (interaction.commandName === 'generate') {
         const override_key = interaction.options.getString('override_key');
         const target_user = interaction.options.getString('target_user');
         const assigned_tier = interaction.options.getInteger('assigned_tier');
         const scope = interaction.options.getString('scope');
 
         // Ephemeral so override key doesn't leak
         await interaction.deferReply({ flags: MessageFlags.Ephemeral });
 
         try {
             const response = await axios.post('http://localhost:3000/api/v1/generate-token', 
                 {
                     targetUser: target_user,
                     assignedTier: assigned_tier,
                     scope: scope
                 },
                {
                    headers: {
                        'x-override-key': override_key,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const { token, targetUser, assignedTier } = response.data;
            await interaction.editReply({ 
                content: `✅ **Token Successfully Generated!**\n\n**Token:** \`${token}\`\n**Target User:** ${targetUser}\n**Tier:** ${assignedTier}\n\n*Provide this token to the operative for linking.*` 
            });

        } catch (error) {
            console.error('[BOT] API Error during /generate:', error?.response?.data || error.message);
            if (error.response) {
                const status = error.response.status;
                if (status === 401) {
                    await interaction.editReply({ content: '❌ Generation Failed: Invalid Override Key.' });
                } else {
                    await interaction.editReply({ content: `❌ Generation Failed: ${error.response.data?.error || 'Unknown Error'}` });
                }
            } else {
                await interaction.editReply({ content: '❌ Could not contact the server.' });
            }
        }
    }
});

// Assuming bot token is stored in process.env.DISCORD_BOT_TOKEN
if (process.env.DISCORD_BOT_TOKEN) {
    client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);
} else {
    console.warn('[BOT] DISCORD_BOT_TOKEN is not set in environment. Bot is not running.');
}
