require('dotenv').config(); // MUST BE LINE 1
const CONFIG = {
    API_BASE: ""
};
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const { google } = require('googleapis');

// 1. Models
const User = require('./models/User'); 
const Division = require('./models/divisions');

const app = express();

// 2. Middleware & Cache Setup
app.use(cors());
app.use(express.json()); // Essential for POST requests
app.use(express.static('public'));

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
const intelCache = new Map(); // Cache for Deep Intel results
const CACHE_TTL = 300000; // 5 minutes in m
const RBX_PROXY = "https://proxy-lite--thanhapple1169.replit.app/"; // Swapped back to roproxy.org for resolution stability

// 3. Webhook Logger Utility
const requestWithRetry = async (url, options = {}, retries = 3, backoff = 2000) => {
    const { method = 'GET', data = null, ...axiosOptions } = options;
    for (let i = 0; i < retries; i++) {
        try {
            if (method === 'POST') {
                return await axios.post(url, data, { ...axiosOptions, timeout: axiosOptions.timeout || 10000 });
            }
            return await axios.get(url, { ...axiosOptions, timeout: axiosOptions.timeout || 10000 });
        } catch (err) {
            const status = err.response ? err.response.status : null;
            if (status === 404) throw err;
            if (i === retries - 1) throw err;
            
            const isRateLimit = status === 429;
            // Steep exponential backoff for 429 + random jitter to prevent collisions
            const baseDelay = isRateLimit ? Math.pow(2, i) * 6000 : backoff * (i + 1);
            const jitter = Math.random() * 2000;
            const delay = baseDelay + jitter;
            
            console.warn(`[RETRY] ${url} failed (${method}, Attempt ${i+1}/${retries}). ${isRateLimit ? 'RATE LIMITED - Backing off...' : err.message}`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
};

const fetchWithRetry = (url, options = {}, retries = 3, backoff = 1000) => 
    requestWithRetry(url, { ...options, method: 'GET' }, retries, backoff);

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
if (!process.env.MONGO_URL) {
    console.error("❌ CRITICAL: MONGO_URL is missing in environment variables!");
} else {
    console.log("📡 Attempting MongoDB Uplink...");
    mongoose.connect(process.env.MONGO_URL)
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
        const groupRes = await fetchWithRetry(`https://groups.${RBX_PROXY}/v1/groups/${groupId}`);
        const data = groupRes.data;

        // 2. Fetch roles (ranks)
        const rolesRes = await fetchWithRetry(`https://groups.${RBX_PROXY}/v1/groups/${groupId}/roles`);
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
        console.error(`[INTEL] Group API Error for ${groupId}:`, error.message, error.response?.status);
        res.status(500).json({ 
            error: 'Failed to fetch unit data', 
            message: error.message 
        });
    }
});



// Unified Verification Route
app.get('/verify-member/:unitName/:username', protectTier(2), async (req, res) => {
    try {
        const { unitName, username } = req.params;
        console.log(`Scanning for Unit: "${unitName}"`);

        // 1. Roblox RESOLUTION (Exact -> Fuzzy Fallback)
        console.log(`[SCAN] Resolving Roblox Identity: "${username}"`);
        let userData;
        try {
            // PHASE A: Exact Username Lookup (Robust & High Rate Limit)
            const exactRes = await requestWithRetry(`https://users.${RBX_PROXY}/v1/usernames/users`, {
                method: 'POST',
                data: {
                    usernames: [username.trim()],
                    excludeBannedUsers: false
                },
                timeout: 5000
            });
            
            userData = exactRes.data.data[0];

            // PHASE B: Fuzzy Search Fallback (Only if exact fails)
            if (!userData) {
                console.log(`[SCAN] No exact match for "${username}". Attempting fuzzy search...`);
                // limit=1 is more economical for fuzzy search
                const searchRes = await fetchWithRetry(`https://users.${RBX_PROXY}/v1/users/search?keyword=${encodeURIComponent(username.trim())}&limit=1`, { timeout: 5000 });
                userData = searchRes.data.data[0];
            }
        } catch (rbErr) {
            if (rbErr.response?.status === 429) {
                console.warn(`[SCAN] ⚠️ Roblox Rate Limit (429) Enforced.`);
                return res.status(429).json({ message: "Uplink Congested" });
            }
            console.error(`[SCAN] Roblox API Error: ${rbErr.response?.status || rbErr.message}`);
            return res.status(500).json({ message: "Uplink Error" });
        }

        if (!userData) {
            console.warn(`[SCAN] Roblox Keyword NOT FOUND: "${username}"`);
            return res.status(404).json({ message: "User Not Found" });
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
            const rbRes = await fetchWithRetry(`https://groups.${RBX_PROXY}/v1/users/${rbId}/groups/roles`);
            const groups = rbRes.data.data;
            
            groupData = groups.find(g => g.group.id == unit.groupId);
            nsGroupData = groups.find(g => g.group.id == NS_GROUP_ID);

            // Fetch all known subunits from DB to map them
            const allDivs = await mongoose.model('Division').find({});
            const subUnitList = allDivs.flatMap(d => d.subUnits);

            groups.forEach(g => {
                const matchedSub = subUnitList.find(s => s.groupId == g.group.id);
                if (matchedSub) {
                    subDivisions.push({
                        name: matchedSub.name,
                        rank: g.role.name,
                        rankId: g.role.rank
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
        const force = req.query.force === 'true';
        
        // 1. Check Cache
        if (!force && intelCache.has(username.toLowerCase())) {
            const cached = intelCache.get(username.toLowerCase());
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                return res.json(cached.data);
            }
        }
        
        // Resolve User (Move resolution below cache check for efficiency)
        const exactRes = await requestWithRetry(`https://users.${RBX_PROXY}/v1/usernames/users`, {
            method: 'POST',
            data: {
                usernames: [username.trim()],
                excludeBannedUsers: false
            }
        });
        const userData = exactRes.data.data[0];
        if (!userData) return res.status(404).json({ message: "User not found" });

        const userId = userData.id;

        // 2. Fetch DATA with staggered execution to avoid Proxy Rate Limits
        const staggeredFetch = async (url, delay = 0) => {
            if (delay > 0) await new Promise(r => setTimeout(r, delay));
            return fetchWithRetry(url);
        };

        const [groupsRes, avatarRes, bustRes, badgesRes, detailedRes, outfitRes, rotectorRes] = await Promise.all([
            staggeredFetch(`https://groups.${RBX_PROXY}/v1/users/${userId}/groups/roles`, 0).catch(e => ({ data: { data: [] } })),
            staggeredFetch(`https://thumbnails.${RBX_PROXY}/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`, 200).catch(e => ({ data: { data: [{ imageUrl: "" }] } })),
            staggeredFetch(`https://thumbnails.${RBX_PROXY}/v1/users/avatar-bust?userIds=${userId}&size=150x150&format=Png&isCircular=false`, 400).catch(e => ({ data: { data: [{ imageUrl: "" }] } })),
            staggeredFetch(`https://badges.${RBX_PROXY}/v1/users/${userId}/badges?limit=25&sortOrder=Desc`, 600).catch(e => ({ data: { data: [] } })),
            staggeredFetch(`https://users.${RBX_PROXY}/v1/users/${userId}`, 800).catch(e => ({ data: {} })),
            fetchWithRetry(`https://avatar.${RBX_PROXY}/v1/users/${userId}/outfits?isEditable=true&itemsPerPage=50`, {}, 4, 3000).catch(e => ({ data: { data: [] } })),
            fetchWithRetry(`https://roscoe.rotector.com/v1/users/${userId}`, {
                headers: process.env.ROTECTOR_API_KEY ? { 'Authorization': `Bearer ${process.env.ROTECTOR_API_KEY}` } : {}
            }).catch(e => {
                if (e.response && e.response.status === 404) return { data: null };
                return { data: null };
            })
        ]);

        const groups = groupsRes.data?.data || [];
        const badges = (badgesRes.data?.data || []).slice(0, 24);
        const avatar = avatarRes.data?.data?.[0]?.imageUrl || "";
        const bust = bustRes.data?.data?.[0]?.imageUrl || "";
        const userDetails = detailedRes.data || {};
        const rawOutfits = outfitRes.data?.data || [];
        const rotector = rotectorRes.data || null;

        // 2.5 Fetch Icons (Groups and Badges)
        let groupIcons = {};
        let badgeIcons = {};
        try {
            const groupIds = groups.map(g => g.group?.id).filter(id => id).slice(0, 100).join(',');
            const badgeIds = badges.map(b => b.id).filter(id => id).slice(0, 50).join(',');

            const fetchGroupIcons = async () => {
                if (!groupIds) return;
                try {
                    const res = await fetchWithRetry(`https://thumbnails.${RBX_PROXY}/v1/groups/icons?groupIds=${groupIds}&size=150x150&format=Png&isCircular=false`);
                    res.data?.data?.forEach(i => groupIcons[i.targetId] = i.imageUrl);
                } catch (e) { console.warn("[ICONS] Group icon fetch failed:", e.message); }
            };

            const fetchBadgeIcons = async () => {
                if (!badgeIds) return;
                try {
                    const res = await fetchWithRetry(`https://thumbnails.${RBX_PROXY}/v1/badges/icons?badgeIds=${badgeIds}&size=150x150&format=Png&isCircular=false`);
                    res.data?.data?.forEach(i => badgeIcons[i.targetId] = i.imageUrl);
                } catch (e) { console.warn("[ICONS] Badge icon fetch failed:", e.message); }
            };

            await Promise.allSettled([fetchGroupIcons(), fetchBadgeIcons()]);
        } catch (iconErr) {
            console.warn("[ICONS] Global icon fetch error:", iconErr.message);
        }

        // 3. Process Outfits (With fallback and thumbnail waiting)
        let outfits = [];
        let finalOutfits = rawOutfits;

        // Fallback: If isEditable=true yielded nothing, try standard fetch
        if (!finalOutfits || finalOutfits.length === 0) {
            try {
                const fallbackRes = await fetchWithRetry(`https://avatar.${RBX_PROXY}/v1/users/${userId}/outfits?itemsPerPage=25`, { timeout: 5000 });
                finalOutfits = fallbackRes.data?.data || [];
            } catch (e) { console.warn("[OUTFIT] Fallback fetch failed"); }
        }

        if (finalOutfits && finalOutfits.length > 0) {
            const filteredOutfits = finalOutfits.slice(0, 24);
            const outfitIds = filteredOutfits.map(o => o.id).join(',');
            
            try {
                // Fetch thumbnails with a slightly longer retry cycle for pending states
                let outfitThumbRes = await fetchWithRetry(`https://thumbnails.${RBX_PROXY}/v1/users/outfits?userOutfitIds=${outfitIds}&size=150x150&format=Png&isCircular=false`, {}, 3, 2000);
                
                // If many are pending, wait once and retry
                const pendingCount = outfitThumbRes.data?.data?.filter(t => t.state !== 'Completed').length || 0;
                if (pendingCount > filteredOutfits.length / 2) {
                    await new Promise(r => setTimeout(r, 2000));
                    outfitThumbRes = await fetchWithRetry(`https://thumbnails.${RBX_PROXY}/v1/users/outfits?userOutfitIds=${outfitIds}&size=150x150&format=Png&isCircular=false`, {}, 1);
                }

                outfits = filteredOutfits.map(o => {
                    const thumb = outfitThumbRes.data?.data?.find(t => t.targetId === o.id);
                    let img = (thumb && thumb.state === 'Completed' && thumb.imageUrl) 
                        ? thumb.imageUrl 
                        : (thumb && thumb.state === 'Pending' ? "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png" : "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png");
                    return { id: o.id, name: o.name || "UNNAMED OUTFIT", thumbnail: img };
                });
            } catch (thumbErr) {
                console.warn(`[THUMB] Outfit Thumbnail fetch failed for ${userId}:`, thumbErr.message);
                outfits = filteredOutfits.map(o => ({ 
                    id: o.id, 
                    name: o.name || "UNNAMED OUTFIT", 
                    thumbnail: "https://tr.rbxcdn.com/38c6edcf096a30366bc90e9d68a2d1d4/150/150/Avatar/Png" 
                }));
            }
        }

        const condoKeywords = ["condo", "inappropriate", "banned", "blacklisted"];
        const isCondo = badges.some(b => condoKeywords.some(kw => b.name.toLowerCase().includes(kw) || b.description.toLowerCase().includes(kw)));

        // Audit Log
        const rotRisk = rotector?.data?.risk_level || "Unknown";
        logAction(req.user, "DEEP_INTEL_SCRAPE", `**Subject:** ${userData.name}\n**ID:** ${userId}\n**Risk Level:** ${isCondo || rotRisk === 'High' ? "CRITICAL" : rotRisk}\n**RoTector Info:** ${rotector ? "CONNECTED" : "OFFLINE"}`);

        const responseData = {
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
            badges: badges.map(b => ({
                name: b.name,
                icon: badgeIcons[b.id] || ""
            })),
            isCondoUser: isCondo,
            rotector: rotector?.data || null
        };

        // Cache the result
        intelCache.set(username.toLowerCase(), {
            timestamp: Date.now(),
            data: responseData
        });

        res.json(responseData);
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`GSMC Terminal active on port ${PORT}`);
});