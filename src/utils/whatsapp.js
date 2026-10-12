const sendWhatsAppOTP = async (phoneNumber, otpCode) => {
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const token = process.env.WHATSAPP_TOKEN;

    if (!phoneId || !token) {
        console.log(`\n=== WHATSAPP SIMULATION (Missing Credentials) ===`);
        console.log(`To: ${phoneNumber} | Code: ${otpCode}`);
        console.log(`==================================================\n`);
        return true;
    }

    try {
        let formattedPhone = phoneNumber.trim();
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '88' + formattedPhone; // Format for Bangladesh
        }

        const response = await fetch(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: formattedPhone,
                type: 'template',
                template: {
                    // ⚠️ REPLACE 'otp_verification' WITH YOUR EXACT TEMPLATE NAME FROM META WHATSAPP MANAGER
                    name: 'otp_verification',
                    language: {
                        code: 'en' // Ensure this matches your approved template's language
                    },
                    components: [
                        {
                            type: 'body',
                            parameters: [
                                {
                                    type: 'text',
                                    text: otpCode.toString() // Injects the actual 6-digit OTP into {{1}}
                                }
                            ]
                        },
                        {
                            type: 'button',
                            sub_type: 'url',
                            index: '0',
                            parameters: [
                                {
                                    type: 'text',
                                    text: otpCode.toString()
                                }
                            ]
                        }
                    ]
                }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('[WHATSAPP API ERROR DETAILS]:', JSON.stringify(data, null, 2));
            console.log(`\n=== FALLBACK CODE ===`);
            console.log(`To: ${phoneNumber} | Code: ${otpCode}`);
            console.log(`=====================\n`);
            return false;
        }

        console.log(`[WHATSAPP API] Live message sent successfully to ${formattedPhone}`);
        return true;

    } catch (error) {
        console.error('Failed to send live WhatsApp OTP:', error);
        console.log(`\n=== FALLBACK CODE ===`);
        console.log(`To: ${phoneNumber} | Code: ${otpCode}`);
        console.log(`=====================\n`);
        return false;
    }
};

module.exports = { sendWhatsAppOTP };