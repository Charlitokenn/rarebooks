<!--
  Web accounting setup wizard (spec 0009 AC-3, AC-4, AC-5). Trimmed to five
  form fields (country, currency, bankName, chartOfAccounts, fiscal year start
  and end); company name, full name, and email are sourced from Clerk, not
  asked. Submitting calls setupWebInstance() through the shared Fyo instance
  and redirects to / on success.

  Spec: docs/specs/0009-web-accounting-setup-wizard/index.md
-->
<template>
  <div class="flex items-center justify-center min-h-screen bg-gray-25 dark:bg-gray-900 p-4">
    <div class="w-full max-w-md bg-white dark:bg-gray-875 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm p-6">
      <h1 class="text-2xl font-semibold text-gray-900 dark:text-gray-25 mb-2">
        {{ t`Set up your organization` }}
      </h1>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-6">
        {{ t`Configure your accounting settings to start using RareBooks` }}
      </p>

      <form @submit.prevent="submit" class="space-y-4">
        <!-- Country -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t`Country` }}
            <span class="text-red-600">*</span>
          </label>
          <input
            v-model="form.country"
            type="text"
            list="countries"
            required
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-25"
          />
          <datalist id="countries">
            <option value="Tanzania" />
            <option value="Kenya" />
          </datalist>
          <p v-if="errors.country" class="text-red-600 text-sm mt-1">{{ errors.country }}</p>
        </div>

        <!-- Currency -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t`Currency` }}
            <span class="text-red-600">*</span>
          </label>
          <input
            v-model="form.currency"
            type="text"
            placeholder="e.g., TZS, KES, USD"
            required
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-25"
          />
          <p v-if="errors.currency" class="text-red-600 text-sm mt-1">{{ errors.currency }}</p>
        </div>

        <!-- Bank Name -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t`Bank Name` }}
            <span class="text-red-600">*</span>
          </label>
          <input
            v-model="form.bankName"
            type="text"
            placeholder="e.g., Main Bank Account"
            required
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-25"
          />
          <p v-if="errors.bankName" class="text-red-600 text-sm mt-1">{{ errors.bankName }}</p>
        </div>

        <!-- Chart of Accounts -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t`Chart of Accounts` }}
            <span class="text-red-600">*</span>
          </label>
          <input
            v-model="form.chartOfAccounts"
            type="text"
            placeholder="e.g., Standard"
            required
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-25"
          />
          <p v-if="errors.chartOfAccounts" class="text-red-600 text-sm mt-1">{{ errors.chartOfAccounts }}</p>
        </div>

        <!-- Fiscal Year Start -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t`Fiscal Year Start` }}
            <span class="text-red-600">*</span>
          </label>
          <input
            v-model="form.fiscalYearStart"
            type="date"
            required
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-25"
          />
          <p v-if="errors.fiscalYearStart" class="text-red-600 text-sm mt-1">{{ errors.fiscalYearStart }}</p>
        </div>

        <!-- Fiscal Year End -->
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {{ t`Fiscal Year End` }}
            <span class="text-red-600">*</span>
          </label>
          <input
            v-model="form.fiscalYearEnd"
            type="date"
            required
            class="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-25"
          />
          <p v-if="errors.fiscalYearEnd" class="text-red-600 text-sm mt-1">{{ errors.fiscalYearEnd }}</p>
        </div>

        <!-- Buttons -->
        <div class="flex gap-3 mt-6 pt-4 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            @click="cancel"
            :disabled="loading"
            class="flex-1 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ t`Cancel` }}
          </button>
          <button
            type="submit"
            :disabled="!isValid || loading"
            class="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span v-if="!loading">{{ t`Submit` }}</span>
            <span v-else>{{ t`Setting up…` }}</span>
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { useRouter } from 'vue-router';
import { fyo } from 'src/initFyo';
import { setupWebInstance } from 'src/web/setupWeb';

export default defineComponent({
  name: 'SetupWizard',
  setup() {
    const router = useRouter();
    return { router };
  },
  data() {
    return {
      form: {
        country: 'Tanzania',
        currency: '',
        bankName: '',
        chartOfAccounts: '',
        fiscalYearStart: '',
        fiscalYearEnd: '',
      },
      errors: {} as Record<string, string>,
      loading: false,
    };
  },
  computed: {
    isValid(): boolean {
      const { country, currency, bankName, chartOfAccounts, fiscalYearStart, fiscalYearEnd } = this.form;
      return !!(country && currency && bankName && chartOfAccounts && fiscalYearStart && fiscalYearEnd);
    },
  },
  methods: {
    async submit() {
      if (!this.isValid) {
        return;
      }

      this.loading = true;
      try {
        await setupWebInstance(this.form, fyo);
        await this.router.push('/');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Setup failed';
        Object.keys(this.form).forEach((key) => {
          this.errors[key] = message;
        });
      } finally {
        this.loading = false;
      }
    },
    cancel() {
      void this.router.back();
    },
  },
});
</script>
