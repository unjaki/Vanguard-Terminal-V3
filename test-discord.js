const axios = require('axios');
const { REST, Routes, SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } = require('discord.js');
require('dotenv').config();

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

async function test() {
    try {
        const res = await axios.put(
            `https://discord.com/api/v10/applications/${process.env.DISCORD_CLIENT_ID}/commands`,
            [linkCommand.toJSON(), searchCommand.toJSON(), generateCommand.toJSON()],
            { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
        );
        console.log("Success!");
    } catch (err) {
        console.error(JSON.stringify(err.response?.data?.errors || err.message, null, 2));
    }
}
test();
