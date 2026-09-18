import test from 'tape';
import { LicenseState } from '../types';
import { calculateGracePeriodEnd, getRemainingDays, isGracePeriodExpiring, isGracePeriodExpired, determineGracePeriodState } from '../validation/grace-period';
import { encrypt, decrypt, generateHmac, verifyHmac } from '../cache/encryption';

// Grace Period Tests
test('Grace Period: Calculate grace period end date', (t) => {
  const now = new Date();
  const lastValidated = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
  const gracePeriodDays = 7;

  const endDate = calculateGracePeriodEnd(lastValidated, gracePeriodDays);
  const daysRemaining = getRemainingDays(endDate);

  t.ok(daysRemaining >= 3 && daysRemaining <= 4, 'should have ~4 days remaining');
  t.equal(isGracePeriodExpired(endDate), false, 'should not be expired');
  t.end();
});

test('Grace Period: Detect expiring soon', (t) => {
  const now = new Date();
  const lastValidated = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000); // 6 days ago
  const gracePeriodDays = 7;

  const endDate = calculateGracePeriodEnd(lastValidated, gracePeriodDays);
  const daysRemaining = getRemainingDays(endDate);

  t.ok(daysRemaining <= 1, 'should have ~1 day remaining');
  t.equal(isGracePeriodExpiring(endDate), true, 'should be expiring soon');
  t.equal(isGracePeriodExpired(endDate), false, 'should not be expired yet');
  t.end();
});

test('Grace Period: Detect expired', (t) => {
  const now = new Date();
  const lastValidated = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
  const gracePeriodDays = 7;

  const endDate = calculateGracePeriodEnd(lastValidated, gracePeriodDays);

  t.equal(isGracePeriodExpired(endDate), true, 'should be expired');
  t.equal(isGracePeriodExpiring(endDate), false, 'not expiring, already expired');
  t.end();
});

test('Grace Period: isGracePeriodExpiring helper', (t) => {
  const now = new Date();
  const expiringSoon = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000); // 1 day in future
  const notExpiring = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000); // 5 days in future

  t.equal(isGracePeriodExpiring(expiringSoon), true, 'should detect expiring soon');
  t.equal(isGracePeriodExpiring(notExpiring), false, 'should not detect as expiring');
  t.end();
});

test('Grace Period: isGracePeriodExpired helper', (t) => {
  const now = new Date();
  const expired = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day in past
  const notExpired = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000); // 5 days in future

  t.equal(isGracePeriodExpired(expired), true, 'should detect expired');
  t.equal(isGracePeriodExpired(notExpired), false, 'should not detect as expired');
  t.end();
});

// Encryption Tests
test('Encryption: Encrypt and decrypt data', (t) => {
  const originalData = 'sensitive-license-key-12345';

  const encrypted = encrypt(originalData);
  t.ok(encrypted.encrypted, 'encrypted data should exist');
  t.ok(encrypted.iv, 'IV should exist');
  t.ok(encrypted.authTag, 'authTag should exist');

  const decrypted = decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag);
  t.equal(decrypted, originalData, 'decrypted data should match original');
  t.end();
});

test('Encryption: Different IVs produce different ciphertexts', (t) => {
  const data = 'test-data';

  const encrypted1 = encrypt(data);
  const encrypted2 = encrypt(data);

  t.notEqual(encrypted1.encrypted, encrypted2.encrypted, 'same data encrypted twice should produce different ciphertexts');
  t.equal(decrypt(encrypted1.encrypted, encrypted1.iv, encrypted1.authTag), data, 'first encryption should decrypt correctly');
  t.equal(decrypt(encrypted2.encrypted, encrypted2.iv, encrypted2.authTag), data, 'second encryption should decrypt correctly');
  t.end();
});

test('Encryption: Wrong authTag fails decryption', (t) => {
  const data = 'secret-data';

  const encrypted = encrypt(data);
  const wrongAuthTag = 'aaaaaaaaaaaaaaaa'; // 16 bytes hex = 8 bytes

  try {
    decrypt(encrypted.encrypted, encrypted.iv, wrongAuthTag);
    t.fail('should throw error with wrong authTag');
  } catch (error) {
    t.ok(error instanceof Error, 'should throw Error');
    t.end();
  }
});

test('Encryption: HMAC integrity verification', (t) => {
  const data = 'test-data';

  const hmac = generateHmac(data);
  t.ok(typeof hmac === 'string', 'HMAC should be a string');
  t.ok(hmac.length > 0, 'HMAC should not be empty');

  const isValid = verifyHmac(data, hmac);
  t.equal(isValid, true, 'integrity check should pass for valid data');

  const tampered = 'tampered-data';
  const isTampered = verifyHmac(tampered, hmac);
  t.equal(isTampered, false, 'integrity check should fail for tampered data');

  t.end();
});

// License State Tests
test('License States: All states are defined', (t) => {
  const states = [
    LicenseState.ACTIVE_ONLINE,
    LicenseState.ACTIVE_OFFLINE,
    LicenseState.GRACE_EXPIRING,
    LicenseState.GRACE_EXPIRED,
    LicenseState.INVALID,
    LicenseState.EXPIRED,
    LicenseState.UNLICENSED,
  ];

  states.forEach((state) => {
    t.ok(typeof state === 'string', `${state} should be a string`);
    t.ok(state.length > 0, `${state} should not be empty`);
  });

  t.end();
});

test('License States: Unique values', (t) => {
  const states = Object.values(LicenseState);
  const uniqueStates = new Set(states);

  t.equal(
    states.length,
    uniqueStates.size,
    'all license states should have unique values'
  );
  t.end();
});

// Edge Cases
test('Grace Period: Edge case - exactly at boundary', (t) => {
  const now = new Date();
  const lastValidated = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // exactly 7 days
  const gracePeriodDays = 7;

  const endDate = calculateGracePeriodEnd(lastValidated, gracePeriodDays);
  const daysRemaining = getRemainingDays(endDate);

  t.equal(daysRemaining, 0, 'should have 0 days remaining at boundary');
  // At boundary with 0 days remaining, not yet expired but will be very soon
  t.equal(isGracePeriodExpired(endDate), false, 'should not be expired at boundary (still valid)');
  t.end();
});

test('Grace Period: Edge case - future date', (t) => {
  const now = new Date();
  const futureDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days in future
  const gracePeriodDays = 7;

  const endDate = calculateGracePeriodEnd(futureDate, gracePeriodDays);
  const daysRemaining = getRemainingDays(endDate);

  t.ok(daysRemaining > 7, 'should have more than grace period days remaining');
  t.equal(isGracePeriodExpiring(endDate), false, 'should not be expiring for future dates');
  t.equal(isGracePeriodExpired(endDate), false, 'should not be expired for future dates');
  t.end();
});

test('Encryption: Edge case - empty string', (t) => {
  const emptyString = '';

  const encrypted = encrypt(emptyString);
  const decrypted = decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag);

  t.equal(decrypted, emptyString, 'should handle empty string correctly');
  t.end();
});

test('Encryption: Edge case - special characters', (t) => {
  const specialChars = '!@#$%^&*()_+-=[]{}|;\':\",.\\<>?/~`';

  const encrypted = encrypt(specialChars);
  const decrypted = decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag);

  t.equal(decrypted, specialChars, 'should handle special characters correctly');
  t.end();
});

test('Encryption: Edge case - unicode characters', (t) => {
  const unicode = 'Hello 🚀 émojis';

  const encrypted = encrypt(unicode);
  const decrypted = decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag);

  t.equal(decrypted, unicode, 'should handle unicode correctly');
  t.end();
});
