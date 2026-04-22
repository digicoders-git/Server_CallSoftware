const mongoose = require('mongoose');

const MONGO_URI = 'mongodb+srv://digicodersdevelopment_db_user:gqkXUNP3JO1v3Gp9@cluster0.zchfesj.mongodb.net/calldatasoftware?appName=Cluster0';

const connectDB = async () => {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB connected — calldatasoftware');
};

// ── Schemas ──────────────────────────────────────────

const UserSchema = new mongoose.Schema({
    username:    { type: String, unique: true },
    obd_token:   String,
    obd_user_id: String,
    last_login:  { type: Date, default: Date.now }
});

const StudentSchema = new mongoose.Schema({
    name:       String,
    phone:      { type: String, unique: true },
    group_id:   Number,
    last_called: Date
});

const PromptSchema = new mongoose.Schema({
    obd_prompt_id: String,
    file_name:     String,
    category:      String,
    status:        String
});

const CampaignSchema = new mongoose.Schema({
    obd_campaign_id: { type: String, unique: true },
    name:            String,
    status:          String,
    created_at:      { type: Date, default: Date.now }
});

const CallLogSchema = new mongoose.Schema({
    campaign_id: String,
    phone:       String,
    status:      String,
    dtmf:        String,
    duration:    Number,
    timestamp:   { type: Date, default: Date.now }
});

// ── Models ───────────────────────────────────────────

const User     = mongoose.model('User',     UserSchema);
const Student  = mongoose.model('Student',  StudentSchema);
const Prompt   = mongoose.model('Prompt',   PromptSchema);
const Campaign = mongoose.model('Campaign', CampaignSchema);
const CallLog  = mongoose.model('CallLog',  CallLogSchema);

module.exports = { connectDB, User, Student, Prompt, Campaign, CallLog };
