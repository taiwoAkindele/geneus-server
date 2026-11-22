/** Contact details as staff and patients see them in Geneus and in logs: enough to recognise, not to use. */

/** 0803 *** 4567 */
export const maskPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  return digits.length < 7 ? '***' : `${digits.slice(0, 4)} *** ${digits.slice(-4)}`;
};
/** a***@gmail.com */
export const maskEmail = (email: string) => {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};
