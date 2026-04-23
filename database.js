const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://digicodersdevelopment_db_user:gqkXUNP3JO1v3Gp9@cluster0.zchfesj.mongodb.net/calldatasoftware?appName=Cluster0';

const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('MongoDB connected — calldatasoftware');
    } catch (error) {
        console.error('MongoDB connection failed:', error.message);
        process.exit(1);
    }
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
    campaign_id:   String,
    campaign_name: String,
    phone:         String,
    status:        String,
    dtmf:          String,
    duration:      Number,
    timestamp:     { type: Date, default: Date.now },
    agent_number:  String,
    hangup_cause:  String,
    cli:           String
});

// ── Admin User Schema ─────────────────────────────────
const AdminUserSchema = new mongoose.Schema({
    username:   { type: String, unique: true, required: true },
    password:   { type: String, required: true },
    role:       { type: String, enum: ['admin', 'user'], default: 'user' },
    name:       String,
    created_at: { type: Date, default: Date.now },
    is_active:  { type: Boolean, default: true }
});

// ── Assignment Schema ─────────────────────────────────
const AssignmentSchema = new mongoose.Schema({
    call_log_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog', required: true },
    assigned_to:  { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    assigned_by:  { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
    assigned_at:  { type: Date, default: Date.now },
    phone:        String,
    campaign_id:  String,
    campaign_name: String
});

// ── Remark Schema ─────────────────────────────────────
const RemarkSchema = new mongoose.Schema({
    call_log_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog', required: true },
    user_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    user_name:    String,
    remark:       String,
    call_done:    { type: Boolean, default: false },
    created_at:   { type: Date, default: Date.now }
});

// ── Models ───────────────────────────────────────────
const User       = mongoose.model('User',       UserSchema);
const Student    = mongoose.model('Student',    StudentSchema);
const Prompt     = mongoose.model('Prompt',     PromptSchema);
const Campaign   = mongoose.model('Campaign',   CampaignSchema);
const CallLog    = mongoose.model('CallLog',    CallLogSchema);
const AdminUser  = mongoose.model('AdminUser',  AdminUserSchema);
const Assignment = mongoose.model('Assignment', AssignmentSchema);
const Remark     = mongoose.model('Remark',     RemarkSchema);

module.exports = { connectDB, User, Student, Prompt, Campaign, CallLog, AdminUser, Assignment, Remark };
