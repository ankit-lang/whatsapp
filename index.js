// Primary operational endpoint mapping handles both forms dynamically
app.post('/api/v1/send-lead', async (req, res) => {
    const { 
        name, fullName, email, phone, 
        date, time, persons, foundVia, dob, notes, // Reservation Form Fields
        subject, message                           // Contact Form Fields
    } = req.body;

    // Normalize name input across both form styles
    const finalName = name || fullName;

    if (!finalName || !email || !phone) {
        return res.status(400).json({ success: false, error: 'Missing required details (name, email, or phone).' });
    }

    const cleanDestinationNumber = phone.replace(/\D/g, ''); 
    const structuralChatId = `${cleanDestinationNumber}@c.us`;

    try {
        const isRegistered = await client.isRegisteredUser(structuralChatId);
        if (!isRegistered) {
            console.log(`⚠️ Number ${cleanDestinationNumber} is not active on WhatsApp.`);
            return res.status(400).json({ success: false, error: 'The provided phone number is not active on WhatsApp.' });
        }

        let textTemplate = '';

        // DYNAMIC DETECTOR: Check if the submission contains specific reservation fields
        if (date || time || persons) {
            textTemplate = ` *Reservation Confirmation*\n\n` +
                           `Hello ${finalName},\n\n` +
                           `Thank you for your booking! Here is the complete summary of your details:\n\n` +
                           ` *Name:* ${finalName}\n` +
                           ` *Email:* ${email}\n` +
                           ` *Phone:* +${cleanDestinationNumber}\n` +
                           ` *Date:* ${date}\n` +
                           ` *Time:* ${time}\n` +
                           ` *Persons:* ${persons}\n` +
                           ` *DOB:* ${dob || 'N/A'}\n` +
                           ` *Found Via:* ${foundVia || 'N/A'}\n` +
                           ` *Special Requests:* ${notes || 'None'}\n\n` +
                           `See you soon! `;
        } else {
            // Fallback layout when handling the generic Contact Form
            textTemplate = `📩 *Contact Form Submission*\n\n` +
                           `Hello ${finalName},\n\n` +
                           `We have safely received your inquiry! Here is a copy of your submission:\n\n` +
                           `👤 *Name:* ${finalName}\n` +
                           `📧 *Email:* ${email}\n` +
                           `📞 *Phone:* +${cleanDestinationNumber}\n` +
                           `📌 *Subject:* ${subject || 'No Subject'}\n` +
                           `💬 *Message:* ${message || 'No Message'}\n\n` +
                           `Our support team will connect with you shortly. 💬`;
        }

        await client.sendMessage(structuralChatId, textTemplate);
        return res.status(200).json({ success: true, message: 'Message routed successfully.' });
    } catch (err) {
        console.error("Internal sending error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});