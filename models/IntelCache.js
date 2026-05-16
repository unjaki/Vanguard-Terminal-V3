const mongoose = require('mongoose');

const IntelCacheSchema = new mongoose.Schema({
    userId: {
        type: Number,
        required: true,
        unique: true
    },
    username: String,
    displayName: String,
    created: String,
    description: String,
    isBanned: Boolean,
    avatar: String,
    bust: String,
    outfits: [{
        id: Number,
        name: String,
        thumbnail: String
    }],
    groups: [{
        id: Number,
        name: String,
        rank: String,
        rankId: Number,
        icon: String
    }],
    badges: [{
        name: String,
        icon: String
    }],
    badgeCount: String,
    isCondoUser: Boolean,
    rotector: mongoose.Schema.Types.Mixed,
    lastScanned: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('IntelCache', IntelCacheSchema);
