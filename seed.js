const { db, initDb } = require('./database');

async function seed() {
    await initDb();
    
    // Seed Students
    const students = [
        ['Rahul Kumar', '919876543210'],
        ['Anjali Sharma', '919876543211'],
        ['Vivek Singh', '919876543212'],
        ['Priya Patel', '919876543213'],
        ['Siddharth Verma', '919876543214']
    ];

    students.forEach(([name, phone]) => {
        db.run(`INSERT OR IGNORE INTO students (name, phone) VALUES (?, ?)`, [name, phone]);
    });

    // Seed Mock Logs
    const logs = [
        ['500486', '919876543210', 'ANSWERED', '2', 15],
        ['500486', '919876543211', 'BUSY', null, 0],
        ['500428', '919876543212', 'ANSWERED', '1', 8],
        ['500428', '919876543213', 'NO_ANSWER', null, 0]
    ];

    logs.forEach(([campaignId, phone, status, dtmf, duration]) => {
        db.run(`INSERT INTO call_logs (campaign_id, phone, status, dtmf, duration) VALUES (?, ?, ?, ?, ?)`,
            [campaignId, phone, status, dtmf, duration]);
    });

    console.log('Database seeded successfully!');
}

seed();
