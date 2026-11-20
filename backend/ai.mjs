export function aiGateway(input) {
  const data = input?.data || {};
  if (input?.action === 'score_lead') {
    const lead = data.lead || {};
    let score = 50;
    if (/\.edu|\.ac\.in/i.test(lead.email || '')) score += 15;
    if (/^\+91|^[6-9]\d{9}$/.test(lead.mobile || '')) score += 10;
    if (lead.city) score += 5;
    if (lead.state) score += 5;
    if (lead.course) score += 10;
    if (['google', 'linkedin', 'referral'].some((source) => String(lead.source || '').toLowerCase().includes(source))) score += 15;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (hour >= 9 && hour <= 18) score += 5;
    score = Math.min(score, 100);
    const quality = score >= 80 ? 'hot' : score >= 50 ? 'warm' : 'cold';
    const recommendations = quality === 'hot'
      ? ['Priority follow-up within 1 hour', 'Assign to senior counselor', 'Schedule campus visit']
      : quality === 'warm'
        ? ['Follow up within 24 hours', 'Send course brochure', 'Add to nurturing sequence']
        : ['Add to long-term nurturing campaign', 'Send educational content', 'Re-engage after 2 weeks'];
    if (!lead.email) recommendations.push('Collect email address');
    if (!lead.course) recommendations.push('Identify course interest');
    return { success: true, score, quality, recommendations };
  }
  if (input?.action === 'analyze_call') {
    const transcript = String(data.transcript || '').toLowerCase();
    const positive = ['interested', 'yes', 'good', 'great', 'thank', 'happy', 'enroll', 'admit'].filter((word) => transcript.includes(word)).length;
    const negative = ['no', 'not interested', 'expensive', 'later', 'busy', 'dont call'].filter((word) => transcript.includes(word)).length;
    const sentiment = positive > negative ? 'positive' : negative > positive ? 'negative' : 'neutral';
    const outcome = positive >= 3 ? 'interested' : negative >= 2 ? 'not_interested' : 'follow_up_needed';
    const suggested_next_action = outcome === 'interested' ? 'Schedule campus visit or send application link'
      : outcome === 'not_interested' ? 'Add to re-engagement campaign'
        : sentiment === 'positive' ? 'Follow up with course details'
          : sentiment === 'negative' ? 'Send soft touch email after 1 week' : 'Schedule follow-up call in 3 days';
    return { success: true, analysis: { sentiment, outcome, positive_signals: positive, negative_signals: negative,
      duration_quality: data.duration > 180 ? 'good' : data.duration > 60 ? 'average' : 'short', suggested_next_action } };
  }
  if (input?.action === 'predict_enrollment') {
    const contacts = Array.isArray(data.contacts) ? data.contacts.slice(0, 1000) : [];
    return { success: true, predictions: contacts.map((contact) => {
      let probability = 0.3;
      if (contact.lead_score >= 80) probability += 0.3;
      else if (contact.lead_score >= 50) probability += 0.15;
      if (contact.activities_count > 5) probability += 0.1;
      if (contact.email_opens > 3) probability += 0.1;
      if (['qualified', 'negotiation'].includes(contact.stage)) probability += 0.15;
      probability = Math.min(probability, 0.95);
      return { contact_id: contact.id, name: contact.name, probability: Math.round(probability * 100),
        confidence: probability > 0.7 ? 'high' : probability > 0.4 ? 'medium' : 'low' };
    }) };
  }
  if (input?.action === 'generate_email') {
    const lead = data.lead || {};
    const name = String(lead.name || 'Student');
    const course = String(lead.course || 'our programs');
    const templates = {
      welcome: { subject: `Welcome to ${lead.university || 'Our Institution'} - Your Journey Begins!`,
        content: `Dear ${name},\n\nThank you for your interest in our programs. Our counselor will reach out shortly to discuss your requirements and guide you through the admission process.\n\nBest regards,\nAdmissions Team` },
      follow_up: { subject: `Quick follow-up on ${lead.course || 'your inquiry'}`,
        content: `Hi ${name},\n\nI wanted to follow up on our previous conversation about ${course}. Do you have any questions I can answer? I'd be happy to schedule a call.\n\nBest,\nAdmissions Counselor` },
      reminder: { subject: 'Important: Application deadline approaching',
        content: `Dear ${name},\n\nThis is a reminder about your application for ${course}. Please let us know if you need any help.\n\nBest regards,\nAdmissions Team` },
      callback: { subject: "Your requested callback - Let's connect!",
        content: `Hi ${name},\n\nPlease let me know your preferred time for a quick call.\n\nBest,\nAdmissions Counselor` },
    };
    return { success: true, ...(templates[data.template_type] || templates.follow_up) };
  }
  throw Object.assign(new Error('Unknown action'), { status: 400 });
}
