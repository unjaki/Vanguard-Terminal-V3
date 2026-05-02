require('dotenv').config(); // MUST BE LINE 1
const CONFIG = {
    API_BASE: ""
};
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const http = require('http');
const https = require('https');
const cors = require('cors');
const fs = require('fs').promises;
const { google } = require('googleapis');

// 1. Models
const User = require(path.join(__dirname, 'models', 'User.js')); 
const Division = require(path.join(__dirname, 'models', 'divisions.js'));

const ROBLOX_PROXY = process.env.ROBLOX_PROXY || "roblox.com";

const rbApi = (subdomain, endpoint) => {
    if (!ROBLOX_PROXY || ROBLOX_PROXY === "roblox.com") {
        return `https://${subdomain}.roblox.com${endpoint}`;
    }
    
    // Normalize proxy host (remove trailing slash and protocol)
    let proxyHost = ROBLOX_PROXY.trim();
    proxyHost = proxyHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    // Ensure endpoint starts with /
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    
    // Subdomain-based proxy format: https://subdomain.proxy.com/path
    return `https://${subdomain}.${proxyHost}${path}`;
};

const app = express();

// 2. Middleware & Cache Setup
const axiosAgent = new https.Agent({ rejectUnauthorized: false });
axios.defaults.httpsAgent = axiosAgent;

app.use(cors());
app.use(express.json()); // Essential for POST requests
app.use(express.static(path.join(__dirname, 'public')));

// Google Sheets Auth Helper
const getSheetsClient = () => {
    try {
        const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        let privateKey = process.env.GOOGLE_PRIVATE_KEY;

        if (!clientEmail || !privateKey) {
            console.warn("⚠️ Google Sheets credentials missing in .env");
            return null;
        }

        // Robust key cleaning
        privateKey = privateKey.trim();
        
        // Remove wrapping quotes if they exist (supports single and double)
        if ((privateKey.startsWith('"') && privateKey.endsWith('"')) ||
            (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
            privateKey = privateKey.substring(1, privateKey.length - 1);
        }
        
        // Convert literal \n strings to actual newlines
        privateKey = privateKey.replace(/\\n/g, '\n');

        if (!privateKey.includes("BEGIN PRIVATE KEY")) {
            console.warn("⚠️ GOOGLE_PRIVATE_KEY is invalid. It doesn't contain the PEM header.");
            return null;
        }

        console.log(`[SHEETS] Attempting Uplink. Email: ${clientEmail.substring(0, 15)}... Key Length: ${privateKey.length}`);

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: clientEmail,
                private_key: privateKey
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        return sheets;
    } catch (err) {
        console.error("Sheets Init Error:", err.message);
        return null;
    }
};

const groupCache = new Map();
const CACHE_TTL = 300000; // 5 minutes in ms

// 3. Webhook Logger Utility
const logAction = async (user, action, details, color = 3447003) => {
    try {
        if (!process.env.DISCORD_WEBHOOK_URL) return;
        
        const operative = user && user.username ? user.username : (user && user.id ? `ID: ${user.id}` : "Unknown System");
        const scope = user && user.scope ? user.scope : "N/A";

        await axios.post(process.env.DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: "VANGUARD AUDIT LOG",
                fields: [
                    { name: "OPERATIVE", value: `**${operative}**`, inline: true },
                    { name: "UNIT_SCOPE", value: scope, inline: true },
                    { name: "ACTION", value: `\`${action}\``, inline: true },
                    { name: "DETAILS", value: details }
                ],
                color: color,
                timestamp: new Date(),
                footer: { text: "GSMC Operational Intelligence | Audit Protocol" }
            }]
        });
    } catch (err) {
        console.error("Audit Log Failed:", err.message);
    }
};

// 4. Tier Limiter Middleware (Must be defined before routes)
const protectTier = (requiredTier) => {
    return (req, res, next) => {
        const authHeader = req.header('Authorization');
        const token = authHeader ? authHeader.replace('Bearer ', '') : req.header('x-auth-token');

        if (!token) return res.status(401).json({ message: "No token, access denied." });

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            
            // Legacy token handling: if username is missing, we still allow but logAction will show ID
            req.user = decoded;
            req.userTier = decoded.tier;

            if (req.user.tier < requiredTier) {
                return res.status(403).json({ 
                    message: `Access Denied: Requires Tier ${requiredTier}. Your Tier: ${req.user.tier}` 
                });
            }
            next();
        } catch (err) {
            res.status(401).json({ message: "Token is not valid or expired." });
        }
    };
};

// 4. Database Connection
if (!process.env.MONGODB_URI) {
    console.error("❌ CRITICAL: MONGODB_URI is missing in environment variables!");
} else {
    console.log("📡 Attempting MongoDB Uplink...");
    mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log("✅ MongoDB Connected Successfully");
        
        // Bootstrap Default User if Empty
        try {
            const count = await User.countDocuments();
            if (count === 0) {
                console.log("🚀 Bootstrapping default CBRN Admin...");
                const hashedPassword = await bcrypt.hash("CBRN123", 10);
                await User.create({
                    username: "CBRN_Admin",
                    password: hashedPassword,
                    tier: 5,
                    unitScope: "CBRN"
                });
                console.log("✅ Created default account: CBRN_Admin / CBRN123");
            }

            // Bootstrap GSMC Sub-Divisions
            const gsmcDiv = await Division.findOne({ name: "GSMC" });
            const gsmcSubUnits = [
                { name: "TEMS", groupId: 683312869 },
                { name: "6AAU", groupId: 503205291 },
                { name: "AMC", groupId: 1111522787 },
                { name: "MEDSOC", groupId: 842973315 },
                { name: "MEI", groupId: 940557434 },
                { name: "NS", groupId: 1008942731 }
            ];

            if (!gsmcDiv) {
                console.log("🚀 Initializing GSMC Sub-Division Database...");
                await Division.create({ name: "GSMC", subUnits: gsmcSubUnits });
            } else {
                // Update existing subunit IDs if they changed
                let changed = false;
                gsmcSubUnits.forEach(newSub => {
                    const existing = gsmcDiv.subUnits.find(s => s.name === newSub.name);
                    if (!existing || existing.groupId !== newSub.groupId) {
                        if (!existing) gsmcDiv.subUnits.push(newSub);
                        else existing.groupId = newSub.groupId;
                        changed = true;
                    }
                });
                if (changed) {
                    await gsmcDiv.save();
                    console.log("✅ GSMC Sub-Divisions Synchronized.");
                }
            }
        } catch (bootErr) {
            console.error("❌ Bootstrap Error:", bootErr.message);
        }
    })
    .catch(err => {
        console.error("❌ MongoDB Connection Error:", err.message);
        console.error("Check if your Mongo Atlas whitelist includes IP 0.0.0.0/0");
    });
}

// 🩺 Debug: Database Status
app.get('/system/status', (req, res) => {
    res.json({
        database: mongoose.connection.readyState === 1 ? "ONLINE" : "OFFLINE",
        uptime: process.uptime(),
        env: process.env.NODE_ENV || "development"
    });
});

// --- ROUTES ---

// Auth Verification for Frontend
app.get('/auth/verify', protectTier(2), (req, res) => {
    res.json({ success: true, tier: req.user.tier, unitScope: req.user.scope });
});

// Login (The JWT "Badge" Generator)
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log(`[AUTH] Login attempt for: ${username}`);

        const userData = await User.findOne({ username });
        if (!userData) {
            console.warn(`[AUTH] User not found: ${username}`);
            return res.status(400).json({ message: "User not found" });
        }

        const isMatch = await bcrypt.compare(password, userData.password);
        if (!isMatch) {
            console.warn(`[AUTH] Invalid credentials for: ${username}`);
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const token = jwt.sign(
            { 
                id: userData._id, 
                username: userData.username, 
                tier: userData.tier, 
                scope: userData.unitScope 
            },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        // Discord Webhook Notification
        try {
            await axios.post(process.env.DISCORD_WEBHOOK_URL, {
                embeds: [{
                    title: "GSMC System Access",
                    description: `**Officer:** ${username}\n**Access Tier:** ${userData.tier}\n**Scope:** ${userData.unitScope}`,
                    color: userData.tier === 5 ? 15158332 : 3447003,
                    timestamp: new Date()
                }]
            });
        } catch (webhookErr) { console.error("Webhook Failed"); }

        res.json({ 
            message: `Welcome back, ${username}`, 
            token, 
            tier: userData.tier,
            unitScope: userData.unitScope
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/group-info/:groupId', protectTier(2), async (req, res) => {
    const { groupId } = req.params;

    if (!groupId || !/^\d+$/.test(groupId)) {
        return res.status(400).json({ 
            error: 'Invalid Group ID', 
            details: 'Numeric ID required.' 
        });
    }

    // 1. Check Cache
    const cached = groupCache.get(groupId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[INTEL] Cache Hit: ${groupId}`);
        return res.json(cached.data);
    }

    try {
        console.log(`[INTEL] Fetching Roblox Data: ${groupId}`);
        // 1. Fetch main group metadata
        const groupRes = await axios.get(rbApi('groups', `/v1/groups/${groupId}`), { timeout: 5000 });
        const data = groupRes.data;

        // 2. Fetch roles (ranks)
        const rolesRes = await axios.get(rbApi('groups', `/v1/groups/${groupId}/roles`), { timeout: 5000 });
        const roles = rolesRes.data.roles.sort((a, b) => b.rank - a.rank); // Sort by rank level desc

        const result = {
            name: data.name,
            memberCount: data.memberCount,
            description: data.description,
            owner: data.owner ? {
                username: data.owner.username,
                userId: data.owner.userId
            } : { username: "None", userId: 0 },
            shout: data.shout ? data.shout.body : null,
            roles: roles.map(r => ({ name: r.name, rank: r.rank, memberCount: r.memberCount }))
        };

        // Audit Log
        logAction(req.user, "UNIT_INTEL_LOOKUP", `**Target Unit:** ${data.name}\n**ID:** ${groupId}`);

        // Cache result
        groupCache.set(groupId, {
            timestamp: Date.now(),
            data: result
        });

        res.json(result);

    } catch (error) {
        if (error.response?.status === 429) {
            console.warn(`[INTEL] ⚠️ Roblox Rate Limit (429) on Intel.`);
            return res.status(429).json({ 
                error: 'Uplink Congested', 
                message: 'Roblox is limiting requests. Please try again in a few minutes.' 
            });
        }
        const requestUrl = error.config?.url || "Unknown URL";
        console.error(`Group API Error [${requestUrl}]:`, error.message);
        if (error.response) {
            console.error('Response Data:', JSON.stringify(error.response.data));
        }
        res.status(500).json({ 
            error: 'Failed to fetch unit data', 
            message: error.message,
            debug_url: requestUrl
        });
    }
});



// Unified Verification Route
app.get('/verify-member/:unitName/:username', protectTier(2), async (req, res) => {
    try {
        const { unitName, username } = req.params;
        if (!username || !username.trim()) {
            return res.status(404).json({ message: "Not in group or name typo" });
        }
        console.log(`Scanning for Unit: "${unitName}"`);

        // 1. Roblox RESOLUTION (Exact -> Fuzzy Fallback)
        console.log(`[SCAN] Resolving Roblox Identity: "${username}"`);
        let userData;
        try {
            // PHASE A: Exact Username Lookup (Robust & High Rate Limit)
            const exactRes = await axios.post(rbApi('users', '/v1/usernames/users'), {
                usernames: [username.trim()],
                excludeBannedUsers: false
            }, { timeout: 5000 });
            
            userData = exactRes.data.data[0];

            // PHASE B: Fuzzy Search Fallback (Only if exact fails)
            if (!userData) {
                console.log(`[SCAN] No exact match for "${username}". Attempting fuzzy search...`);
                // limit=1 is more economical for fuzzy search
                const searchRes = await axios.get(rbApi('users', `/v1/users/search?keyword=${encodeURIComponent(username.trim())}&limit=1`), { timeout: 5000 });
                userData = searchRes.data.data[0];
            }
        } catch (rbErr) {
            const status = rbErr.response?.status;
            const requestUrl = rbErr.config?.url || "Unknown URL";
            
            if (status === 429) {
                console.warn(`[SCAN] ⚠️ Roblox Rate Limit (429) Enforced.`);
                return res.status(429).json({ message: "Uplink Congested" });
            }
            if (status === 400) {
                console.warn(`[SCAN] Roblox API rejected request (400): Malformed username "${username}"`);
                return res.status(404).json({ message: "Not in group or name typo" });
            }
            console.error(`[SCAN] Roblox API Error: ${status || rbErr.message} at ${requestUrl}`);
            if (rbErr.response) {
                console.error('Response Data:', JSON.stringify(rbErr.response.data));
            }
            return res.status(500).json({ message: `Uplink Error ${status || ''}`, debug_url: requestUrl });
        }

        if (!userData) {
            console.warn(`[SCAN] Roblox Keyword NOT FOUND: "${username}"`);
            return res.status(404).json({ message: "Not in group or name typo" });
        }
        
        // 1.5 Find Target Unit
        let unit = null;
        try {
            const Division = mongoose.model('Division'); // Ensure access to model
            const division = await Division.findOne({ "subUnits.name": unitName });
            unit = division?.subUnits.find(u => u.name === unitName);
            
            if (!unit && /^\d+$/.test(unitName)) {
                unit = { name: "Direct Uplink", groupId: parseInt(unitName) };
            }
        } catch (dbErr) {
            console.error(`[SCAN] Database Error: ${dbErr.message}`);
        }

        if (!unit) {
            return res.status(404).json({ message: "Unit Not Configured" });
        }

        const rbId = userData.id;
        const robloxUsername = userData.name; // This is the REAL current username
        console.log(`[SCAN] ✅ Found: ${username} -> ${rbId} (${robloxUsername})`);

        // Audit Log
        logAction(req.user, "PERSONNEL_SCAN", `**Subject:** ${robloxUsername}\n**Unit:** ${unitName}\n**ID:** ${rbId}`);

        // 2. Rank Check (Enhanced for all Sub-Divisions)
        let groupData = null;
        let nsGroupData = null;
        let subDivisions = [];
        const NS_GROUP_ID = "1008942731";

        try {
            const rbRes = await axios.get(rbApi('groups', `/v1/users/${rbId}/groups/roles`));
            const groups = rbRes.data.data;
            
            groupData = groups.find(g => g.group.id == unit.groupId);
            if (!groupData) {
                return res.status(404).json({ message: "Not in group or name typo" });
            }
            nsGroupData = groups.find(g => g.group.id == NS_GROUP_ID);

            // Fetch all known subunits from DB to map them
            const allDivs = await mongoose.model('Division').find({});
            const subUnitList = allDivs.flatMap(d => d.subUnits);

            const groupIds = [...new Set(groups.map(g => g.group?.id))].filter(id => id).slice(0, 100).join(',');
            let iconsMap = {};
            if (groupIds) {
                try {
                    const iconRes = await axios.get(rbApi('thumbnails', `/v1/groups/icons?groupIds=${groupIds}&size=150x150&format=Png&isCircular=false`), { timeout: 5000 });
                    iconRes.data?.data?.forEach(i => {
                        if (i.targetId) iconsMap[i.targetId] = i.imageUrl;
                    });
                } catch (iconErr) {
                    console.warn(`[SCAN] Failed to fetch group icons: ${iconErr.response?.status || iconErr.message}`);
                }
            }

            groups.forEach(g => {
                const matchedSub = subUnitList.find(s => s.groupId == g.group.id);
                if (matchedSub) {
                    let displayName = matchedSub.name;
                    if (displayName.toUpperCase() === "GENERAL STAFF") displayName = "GSMC";
                    
                    subDivisions.push({
                        name: displayName,
                        rank: g.role.name,
                        rankId: g.role.rank,
                        icon: iconsMap[g.group.id] || ""
                    });
                }
            });

        } catch (roleErr) {
            console.error(`[SCAN] Roblox Roles API Error: ${roleErr.message}`);
        }

        // --- ROWIFI VERIFICATION ---
let discordInfo = "Not Linked";

try {
    const guildId = process.env.DISCORD_GUILD_ID;
    const apiKey = (process.env.ROWIFI_API_KEY || "").trim();

    if (guildId && apiKey) {
        // 1. Reverse Lookup (Roblox ID -> Discord Candidates)
        const reverseRes = await axios.get(
            `https://api.rowifi.xyz/v3/guilds/${guildId}/members/roblox/${rbId}`,
            { 
                headers: { 
                    'Authorization': `Bot ${apiKey}` 
                } 
            }
        );

        const data = reverseRes.data;
        let candidates = [];

        if (Array.isArray(data)) {
            candidates = data.map(x => (typeof x === 'object' ? String(x.discord_id) : String(x)));
        } else if (data && data.discord_ids) {
            candidates = data.discord_ids.map(String);
        }

        if (candidates.length > 0) {
            for (const did of candidates) {
                try {
                    const memberRes = await axios.get(
                        `https://api.rowifi.xyz/v3/guilds/${guildId}/members/${did}`,
                        { headers: { 'Authorization': `Bot ${apiKey}` } }
                    );
                    
                    if (String(memberRes.data?.roblox_id) === String(rbId)) {
                        discordInfo = did;
                        console.log(`✅ Verified Link: ${robloxUsername} -> ${did}`);
                        break;
                    }
                } catch (memberErr) {
                    continue;
                }
            }
        }
    } else {
        console.warn("⚠️ RoWifi Integration skipped: Missing Guild ID or API Key");
    }

} catch (err) {
    if (err.response?.status === 401) {
        console.error("❌ 401: Authorization failed. Ensure your key is correct.");
    } else if (err.response?.status === 404) {
        console.log(`ℹ️ No candidates found for ${robloxUsername}`);
    } else {
        console.error(`❌ RoWifi Error: ${err.message}`);
    }
}
// --- END ROWIFI BLOCK ---
        // --- NEW RANK LOGIC (Discord Parity) ---
        let officerStatus = "Enlisted";
        if (groupData) {
            const rankId = groupData.role.rank;
            if (rankId >= 218) officerStatus = "CO";
            else if (rankId >= 213) officerStatus = "NCO";
        }

        let nsStatus = "Enlisted";
        if (nsGroupData) {
            const rankId = nsGroupData.role.rank;
            if (rankId >= 202) nsStatus = "CO";
            else if (rankId >= 9) nsStatus = "NCO";
        }

        // 4. Final Response
        res.json({
            officer: robloxUsername,
            robloxId: rbId,
            discordId: discordInfo, 
            unit: unitName,
            rank: groupData ? groupData.role.name : "UNASSIGNED",
            rankId: groupData ? groupData.role.rank : 0,
            nsRank: nsGroupData ? nsGroupData.role.name : "—",
            status: officerStatus,
            nsStatus: nsStatus,
            subDivisions: subDivisions
        });

    } catch (err) {
        console.error("Route Error:", err.message);
        res.status(500).json({ error: "Internal System Error: " + err.message });
    }
});

// --- DEEP INTEL ROUTE ---
app.get('/deep-intel/:username', protectTier(2), async (req, res) => {
    try {
        const { username } = req.params;
        if (!username || !username.trim()) {
            return res.status(404).json({ message: "Not in group or name typo" });
        }
        console.log(`[INTEL] Initiating Deep Recon for: ${username}`);
        
        // 1. Resolve Identity
        let userData;
        try {
            const exactRes = await axios.post(rbApi('users', '/v1/usernames/users'), {
                usernames: [username.trim()],
                excludeBannedUsers: false
            }, { timeout: 5000 });
            userData = exactRes.data.data[0];
        } catch (identErr) {
            if (identErr.response?.status === 400) {
                return res.status(404).json({ message: "Not in group or name typo" });
            }
            throw identErr;
        }
        if (!userData) return res.status(404).json({ message: "Not in group or name typo" });

        const userId = userData.id;
        console.log(`[INTEL] User Resolved: ${userData.name} (${userId}). Applying 10s suppression delay...`);

        // Mandatory 10s delay to stay under Roblox rate limits (Requested by operative)
        // We use this window to pinpoint the exact badge count by walking cursors
        console.log(`[INTEL] Starting Badge Pinpoint Walker for ${userId}...`);
        const badgePinpointPromise = (async () => {
            let total = 0;
            let cursor = "";
            let attempts = 0;
            let sampleBadges = [];
            const startTime = Date.now();
            
            // Create a high-performance walker client with keepAlive
            const walkerAxios = axios.create({
                httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
                httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100, rejectUnauthorized: false }),
                timeout: 5000
            });

            try {
                // Initial probe
                while (attempts < 150) { // Support up to 15,000 badges
                    // Aggressive threshold: Use up to 9.8s of the 10s window
                    if (Date.now() - startTime > 9800) break; 

                    const res = await walkerAxios.get(rbApi('badges', `/v1/users/${userId}/badges?limit=100&cursor=${cursor}`));
                    const data = res.data;
                    if (!data) break;

                    const pageData = data.data || [];
                    if (attempts === 0) sampleBadges = pageData;
                    
                    total += pageData.length;
                    cursor = data.nextPageCursor;
                    
                    if (!cursor || pageData.length < 100) return { count: total, complete: true, sample: sampleBadges };
                    attempts++;
                }
                return { count: total, complete: false, sample: sampleBadges };
            } catch (e) {
                console.warn(`[INTEL] Badge Walker interrupted at ${total}:`, e.message);
                return { count: total, complete: false, sample: sampleBadges };
            }
        })();

        await new Promise(resolve => setTimeout(resolve, 10000));
        const pinpointResult = await badgePinpointPromise;
        const finalBadgeCount = pinpointResult.complete ? pinpointResult.count : `${pinpointResult.count}+`;
        console.log(`[INTEL] Pinpoint complete: ${finalBadgeCount} badges identified.`);

        // 2. Fetch Core Data (Parallel Batch 1)
        console.log(`[INTEL] Batch 1: Metadata, Groups, RoTector`);
        
        const [groupsRes, detailedRes, rotectorRes] = await Promise.all([
            axios.get(rbApi('groups', `/v1/users/${userId}/groups/roles`), { timeout: 10000 }).catch(e => {
                if (e.response?.status === 429) console.warn("[RATELIMIT] Groups API throttled");
                return { data: { data: [] } };
            }),
            axios.get(rbApi('users', `/v1/users/${userId}`), { timeout: 10000 }).catch(e => {
                if (e.response?.status === 429) console.warn("[RATELIMIT] Users API throttled");
                return { data: {} };
            }),
            axios.get(`https://roscoe.rotector.com/v1/users/${userId}`, {
                timeout: 8000
            }).catch(e => {
                console.warn("[ROTECTOR] Service unavailable or throttled");
                return { data: null };
            })
        ]);

        // Small gap between batches
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 3. Fetch Visual Data & Outfits (Batch 2)
        console.log(`[INTEL] Batch 2: Visuals, Outfits`);
        const [avatarRes, bustRes, outfitRes] = await Promise.all([
            axios.get(rbApi('thumbnails', `/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`), { timeout: 10000 }).catch(e => ({ data: { data: [{ imageUrl: "" }] } })),
            axios.get(rbApi('thumbnails', `/v1/users/avatar-bust?userIds=${userId}&size=150x150&format=Png&isCircular=false`), { timeout: 10000 }).catch(e => ({ data: { data: [{ imageUrl: "" }] } })),
            axios.get(rbApi('avatar', `/v1/users/${userId}/outfits?isEditable=true&itemsPerPage=50`), { timeout: 10000 }).catch(e => {
                if (e.response?.status === 429) console.warn("[RATELIMIT] Outfits API throttled");
                return { data: { data: [] } };
            })
        ]);

        const groups = groupsRes.data?.data || [];
        const badgesSample = (pinpointResult.sample || []).slice(0, 24);
        const avatar = avatarRes.data?.data?.[0]?.imageUrl || "";
        const bust = bustRes.data?.data?.[0]?.imageUrl || "";
        const userDetails = detailedRes.data || {};
        const rawOutfits = outfitRes.data?.data || [];
        const rotector = rotectorRes.data || null;
        
        console.log(`[INTEL] Data Pulled. Outfits: ${rawOutfits.length}, Groups: ${groups.length}, Badges: ${finalBadgeCount}`);

        // 3.5 Fetch Icons (Groups and Badges)
        let groupIcons = {};
        let badgeIcons = {};
        try {
            const groupIds = groups.map(g => g.group?.id).filter(id => id).slice(0, 100).join(',');
            const badgeIds = badgesSample.map(b => b.id).filter(id => id).slice(0, 50).join(',');

            const fetchGroupIcons = async () => {
                if (!groupIds) return;
                try {
                    const res = await axios.get(rbApi('thumbnails', '/v1/groups/icons'), {
                        params: { groupIds, size: '150x150', format: 'Png', isCircular: false },
                        timeout: 8000
                    });
                    res.data?.data?.forEach(i => groupIcons[i.targetId] = i.imageUrl);
                } catch (e) { 
                    if (e.response?.status === 429) console.warn("[RATELIMIT] Group Icons throttled");
                    else console.warn("[ICONS] Group icon fetch failed:", e.message); 
                }
            };

            const fetchBadgeIcons = async () => {
                if (!badgeIds) return;
                try {
                    const res = await axios.get(rbApi('thumbnails', '/v1/badges/icons'), {
                        params: { badgeIds, size: '150x150', format: 'Png', isCircular: false },
                        timeout: 8000
                    });
                    res.data?.data?.forEach(i => badgeIcons[i.targetId] = i.imageUrl);
                } catch (e) { 
                    if (e.response?.status === 429) console.warn("[RATELIMIT] Badge Icons throttled");
                    else console.warn("[ICONS] Badge icon fetch failed:", e.message); 
                }
            };

            await Promise.allSettled([fetchGroupIcons(), fetchBadgeIcons()]);
        } catch (iconErr) {
            console.warn("[ICONS] Global icon fetch error:", iconErr.message);
        }

        // 4. Process Outfits (Thumbnail Batch)
        let outfits = [];
        if (rawOutfits && Array.isArray(rawOutfits) && rawOutfits.length > 0) {
            const filteredOutfits = rawOutfits.slice(0, 24);
            const outfitIds = filteredOutfits.map(o => o.id).join(',');
            
            if (outfitIds) {
                try {
                    console.log(`[INTEL] Fetching outfit thumbnails for IDs: ${outfitIds.substring(0, 30)}...`);
                    const outfitThumbRes = await axios.get(rbApi('thumbnails', `/v1/users/outfits?userOutfitIds=${outfitIds}&size=150x150&format=Png&isCircular=false`), { timeout: 15000 });
                    
                    outfits = filteredOutfits.map(o => {
                        const thumb = outfitThumbRes.data?.data?.find(t => t.targetId === o.id);
                        let img = (thumb && thumb.state === 'Completed' && thumb.imageUrl) 
                            ? thumb.imageUrl 
                            : "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png";
                        return { id: o.id, name: o.name || "UNNAMED OUTFIT", thumbnail: img };
                    });
                } catch (thumbErr) {
                    if (thumbErr.response?.status === 429) console.warn("[RATELIMIT] Outfit Thumbnails throttled");
                    else console.warn(`[THUMB] Outfit Thumbnail fetch failed for ${userId}:`, thumbErr.message);
                    outfits = filteredOutfits.map(o => ({ 
                        id: o.id, 
                        name: o.name || "UNNAMED OUTFIT", 
                        thumbnail: "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png" 
                    }));
                }
            }
        }

        const condoKeywords = ["condo", "inappropriate", "banned", "blacklisted"];
        const isCondo = badgesSample.some(b => condoKeywords.some(kw => b.name.toLowerCase().includes(kw) || (b.description && b.description.toLowerCase().includes(kw))));

        // Audit Log
        const rotRisk = rotector?.data?.risk_level || "Unknown";
        logAction(req.user, "DEEP_INTEL_SCRAPE", `**Subject:** ${userData.name}\n**ID:** ${userId}\n**Risk Level:** ${isCondo || rotRisk === 'High' ? "CRITICAL" : rotRisk}\n**RoTector Info:** ${rotector ? "CONNECTED" : "OFFLINE"}`);

        res.json({
            username: userData.name,
            displayName: userData.displayName,
            userId: userId,
            created: userDetails.created,
            description: userDetails.description,
            isBanned: userDetails.isBanned,
            avatar: avatar,
            bust: bust,
            outfits: outfits,
            groups: groups.map(g => ({
                id: g.group.id,
                name: g.group.name,
                rank: g.role.name,
                rankId: g.role.rank,
                icon: groupIcons[g.group.id] || ""
            })),
            badges: badgesSample.map(b => ({
                name: b.name,
                icon: badgeIcons[b.id] || ""
            })),
            badgeCount: finalBadgeCount,
            isCondoUser: isCondo,
            rotector: rotector?.data || null
        });
    } catch (err) {
        console.error("Deep Intel Error:", err.message);
        res.status(500).json({ message: "Uplink Failed" });
    }
});
// Create User (Register)
app.post('/register', async (req, res) => {
    try {
        const { username, password, tier, division, unitScope } = req.body;
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ 
            username: username, 
            password: hashedPassword, 
            tier: tier, 
            division: division, 
            unitScope: unitScope 
        });
        await newUser.save();
        res.status(201).json({ message: "Secure user created." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ORBAT SYNC ROUTE ---
app.post('/sync-to-orbat', protectTier(3), async (req, res) => {
    try {
        const { officer, robloxId, discordId, unitId, rank, nsRank } = req.body;
        const sheets = getSheetsClient();
        
        if (!sheets) {
            return res.status(500).json({ message: "ORBAT Uplink Offline (Auth Error)" });
        }

        // Determine which sheet to write to
        let rawId = null;
        if (unitId === "288142915") rawId = process.env.GOOGLE_SHEET_ID_GSMC;
        else if (unitId === "423217030") rawId = process.env.GOOGLE_SHEET_ID_CBRN;
        else if (unitId === "1008942731") rawId = process.env.GOOGLE_SHEET_ID_NS;

        // Auto-extract ID if user provided full URL
        const spreadsheetId = rawId?.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || rawId?.trim();

        if (!spreadsheetId) {
            console.error(`[ORBAT] No Sheet ID found for Unit: ${unitId}`);
            return res.status(400).json({ message: "Target ORBAT Not Configured" });
        }

        console.log(`[ORBAT] Attempting Sync to: ${spreadsheetId.substring(0, 10)}... for ${officer}`);

        // Layout: A: Username, B: Roblox ID, C: Discord ID, D: Group Rank, E: NS Rank
        const values = [[
            officer, 
            String(robloxId), 
            String(discordId || "N/A"), 
            String(rank || "—"), 
            String(nsRank || "—")
        ]];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'ORBAT!A:E',
            valueInputOption: 'RAW',
            resource: { values }
        });

        // Audit Log
        logAction(req.user, "ORBAT_SYNC", `**Officer:** ${officer}\n**Target Unit:** ${unitId}\n**Sheet ID:** ${spreadsheetId.substring(0, 15)}...`, 15158332);

        res.json({ success: true, message: "Uplink Successful" });
    } catch (err) {
        console.error("ORBAT Sync Error:", err.message);
        if (err.response?.data) console.error("Sheets API Details:", JSON.stringify(err.response.data));
        res.status(500).json({ error: "Sync Failed", details: err.message });
    }
});

// --- ACCOUNT MANAGEMENT (TIER 3+) ---
app.get('/admin/users', protectTier(3), async (req, res) => {
    try {
        const users = await User.find({}, '-password');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: "Failed to retrieve personnel files." });
    }
});

app.post('/admin/users', protectTier(3), async (req, res) => {
    try {
        const { username, password, tier, unitScope } = req.body;
        
        // Security Check: You can only create users with a tier strictly LOWER than yours
        if (tier >= req.user.tier) {
            return res.status(403).json({ message: "Security Violation: Cannot create an operative with equal or higher clearance." });
        }

        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ message: "Username already active in sector." });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({
            username,
            password: hashedPassword,
            tier: parseInt(tier),
            unitScope
        });

        await newUser.save();
        logAction(req.user, "USER_DEPLOYED", `**New Unit:** ${username}\n**Clearance:** Tier ${tier}\n**Scope:** ${unitScope}`, 3066993);
        
        res.status(201).json({ message: "Operative deployed successfully." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/admin/users/:id', protectTier(3), async (req, res) => {
    try {
        const targetId = req.params.id;
        const targetUser = await User.findById(targetId);

        if (!targetUser) return res.status(404).json({ message: "Target not found." });

        // Security Check: You can only delete users with a tier strictly LOWER than yours
        if (targetUser.tier >= req.user.tier) {
            return res.status(403).json({ message: "Security Violation: Cannot decommission higher or equal clearance personnel." });
        }

        await User.findByIdAndDelete(targetId);
        logAction(req.user, "USER_DECOMMISSIONED", `**Target:** ${targetUser.username}\n**Clearance:** Tier ${targetUser.tier}`, 15158332);
        
        res.json({ message: "Operative decommissioned." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SYSTEM LOGS ---
app.get('/health', (req, res) => {
    res.json({
        status: "OPERATIONAL",
        uptime: process.uptime(),
        database: mongoose.connection.readyState === 1 ? "ONLINE" : "OFFLINE",
        timestamp: new Date().toISOString()
    });
});

app.get('/system/version-log', async (req, res) => {
    try {
        const data = await fs.readFile(path.join(__dirname, 'version-log.json'), 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        res.json([{ version: "V.1", date: "Unknown", notes: ["System Active"] }]);
    }
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`GSMC Terminal active on port ${PORT}`);
    });
}

module.exports = app;