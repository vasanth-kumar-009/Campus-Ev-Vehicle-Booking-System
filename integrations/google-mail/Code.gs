function doPost(event) {
  let ok = false;
  try {
    const secret = PropertiesService.getScriptProperties().getProperty('GOOGLE_SCRIPT_SECRET');
    const data = JSON.parse(event.postData.contents);
    if (!secret || secret.length < 32 || typeof data.payload !== 'string' || data.payload.length > 32000) {
      throw new Error('Invalid request');
    }
    const signature = Utilities.base64Encode(Utilities.computeHmacSha256Signature(data.payload, secret, Utilities.Charset.UTF_8));
    if (data.signature !== signature) throw new Error('Invalid signature');
    const mail = JSON.parse(data.payload);
    if (!Number.isFinite(mail.sentAt) || Math.abs(Date.now() - mail.sentAt) > 120000) throw new Error('Stale message');
    if (typeof mail.to !== 'string' || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(mail.to)) throw new Error('Invalid recipient');
    if (typeof mail.subject !== 'string' || /[\r\n]/.test(mail.subject) || typeof mail.text !== 'string') throw new Error('Invalid message');
    MailApp.sendEmail({ to: mail.to, subject: mail.subject, body: mail.text, name: 'Campus EV' });
    ok = true;
  } catch (error) {
    // The response and execution logs omit email addresses, secrets and reset links.
  }
  return ContentService.createTextOutput(JSON.stringify({ ok })).setMimeType(ContentService.MimeType.JSON);
}
