/**
 * Web setup entry point (spec 0009 AC-3, AC-4). Composes the shared
 * setupInstance helpers, skipping Electron-only pieces (database init,
 * print settings, print templates), and sourcing company name, full name,
 * and email from the Clerk organization and user instead of form input.
 *
 * Spec: docs/specs/0009-web-accounting-setup-wizard/index.md
 */
import { Fyo } from 'fyo';
import { clerk } from 'src/web/clerk';
import {
  createCurrencyRecords,
  createAccountRecords,
  createDefaultNumberSeries,
  updateInventorySettings,
  updateAccountingSettings,
  updateSystemSettings,
  completeSetup,
  createDiscountAccount,
} from 'src/setup/setupInstance';
import { createRegionalRecords } from 'src/regional';
import { SetupWizardOptions } from 'src/setup/types';
import { setCurrencySymbols } from 'src/utils/initialization';

export interface WebSetupOptions {
  country: string;
  currency: string;
  bankName: string;
  chartOfAccounts: string;
  fiscalYearStart: string;
  fiscalYearEnd: string;
}

export async function setupWebInstance(
  options: WebSetupOptions,
  fyo: Fyo
): Promise<void> {
  const companyName = clerk.organization?.name ?? 'Company';
  const email =
    clerk.user?.primaryEmailAddress?.emailAddress ?? 'admin@example.com';
  const fullname =
    clerk.user?.firstName && clerk.user?.lastName
      ? `${clerk.user.firstName} ${clerk.user.lastName}`
      : clerk.user?.firstName ?? 'Admin';

  fyo.store.skipTelemetryLogging = true;

  const setupWizardOptions: SetupWizardOptions = {
    companyName,
    country: options.country,
    bankName: options.bankName,
    chartOfAccounts: options.chartOfAccounts,
    fiscalYearStart: options.fiscalYearStart,
    fiscalYearEnd: options.fiscalYearEnd,
    currency: options.currency,
    fullname,
    email,
    logo: '',
  };

  await updateSystemSettings(setupWizardOptions, fyo);
  await updateAccountingSettings(setupWizardOptions, fyo);

  await createCurrencyRecords(fyo);
  await createAccountRecords(
    options.bankName,
    options.country,
    options.chartOfAccounts,
    fyo
  );
  await createRegionalRecords(options.country, fyo);
  await createDefaultNumberSeries(fyo);
  await updateInventorySettings(fyo);

  await completeSetup(companyName, fyo);
  if (!Object.keys(fyo.currencySymbols).length) {
    await setCurrencySymbols(fyo);
  }

  fyo.store.skipTelemetryLogging = false;
}
