const mongoose = require('mongoose');

const DivisionSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    subUnits: [{
        name: {
            type: String,
            required: true
        },
        groupId: {
            type: Number,
            required: true
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Division', DivisionSchema);
