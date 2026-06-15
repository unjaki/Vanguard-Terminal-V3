const { REST, Routes, SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } = require('discord.js');
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
console.log(JSON.stringify(searchCommand.toJSON(), null, 2));
