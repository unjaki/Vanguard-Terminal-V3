const mongoose = require('mongoose');

const AdminTokenSchema = new mongoose.Schema({
    token: {
        type: String,
        required: true,
        unique: true
    },
    assignedTier: {
        type: Number,
        required: true
    },
    targetUser: {
        type: String,
        required: true
    },
    isUsed: {
        type: Boolean,
        default: false
    },
    linkedAt: {
        type: Date,
        default: null
    }
});

module.exports = mongoose.model('AdminToken', AdminTokenSchema);
