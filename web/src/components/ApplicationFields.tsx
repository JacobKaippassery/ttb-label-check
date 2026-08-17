import { useState } from 'react';
import type { ApplicationForm, BeverageClass } from '../types.ts';
// Imported directly from the rules layer so the picker and the check that
// validates it can never drift apart. reference.ts is pure data with no Node
// imports, so it bundles for the browser unchanged — and there is deliberately
// no second copy of these numbers on the client.
import {
  authorizedFillsFor,
  COMMON_MALT_BEVERAGE_SIZES_ML,
} from '../../../server/rules/reference.ts';

/** 750 → "750 mL", 1500 → "1.5 L". */
function formatMl(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toFixed(2).replace(/\.?0+$/, '')} L` : `${ml} mL`;
}

/**
 * The application record the label is checked against.
 *
 * In a real deployment these values arrive from COLA and the agent never types
 * them. Marcus Williams was explicit that COLA integration is out of scope for
 * a prototype, so they are editable here — which also makes the tool easy to
 * demonstrate and easy to test against deliberate mismatches.
 */
export function ApplicationFields({
  value,
  onChange,
  disabled,
}: {
  value: ApplicationForm;
  onChange: (next: ApplicationForm) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof ApplicationForm>(key: K, v: ApplicationForm[K]) =>
    onChange({ ...value, [key]: v });

  const authorized = authorizedFillsFor(value.beverageClass);
  const sizes = authorized ?? COMMON_MALT_BEVERAGE_SIZES_ML;

  // "Other" is not a convenience — it is required for the net contents check to
  // keep working. An applicant CAN declare a non-standard size, and that is
  // exactly the violation the check exists to catch. A picker limited to
  // authorized sizes would make it impossible to record one, and the tool would
  // silently lose the ability to find it.
  const isListed = value.netContentsMl !== '' && sizes.includes(Number(value.netContentsMl));
  const [otherMode, setOtherMode] = useState(value.netContentsMl !== '' && !isListed);
  const showOther = otherMode || (value.netContentsMl !== '' && !isListed);

  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={disabled}>
      <legend className="visually-hidden">Application details</legend>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="applicationId">Application number</label>
          <input
            id="applicationId"
            type="text"
            value={value.applicationId}
            onChange={(e) => set('applicationId', e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="beverageClass">Product type</label>
          <select
            id="beverageClass"
            value={value.beverageClass}
            onChange={(e) => set('beverageClass', e.target.value as BeverageClass)}
          >
            <option value="distilled_spirits">Distilled spirits</option>
            <option value="wine">Wine</option>
            <option value="malt_beverage">Malt beverage</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="brandName">Brand name</label>
        <input
          id="brandName"
          type="text"
          value={value.brandName}
          onChange={(e) => set('brandName', e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="classType">Class / type designation</label>
        <input
          id="classType"
          type="text"
          value={value.classType}
          onChange={(e) => set('classType', e.target.value)}
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="alcoholContentAbv">Alcohol content</label>
          <p className="hint">Percent by volume. Enter 45 for 45% Alc./Vol.</p>
          <input
            id="alcoholContentAbv"
            type="number"
            step="0.1"
            inputMode="decimal"
            value={value.alcoholContentAbv}
            disabled={value.alcoholContentOptional}
            onChange={(e) => set('alcoholContentAbv', e.target.value)}
          />
          {/*
            TTB exempts some wine and malt beverage products from stating
            alcohol content at all, depending on state law and product type —
            this isn't a missing field, it's a lawfully absent one. Without
            this the check has no way to tell the two apart and would flag
            an exempt product as though its alcohol content statement had
            simply gone missing.
          */}
          {value.beverageClass !== 'distilled_spirits' && (
            <div className="checkbox-row" style={{ marginTop: 10, minHeight: 'auto' }}>
              <input
                id="alcoholContentOptional"
                type="checkbox"
                checked={value.alcoholContentOptional}
                onChange={(e) => set('alcoholContentOptional', e.target.checked)}
              />
              <label htmlFor="alcoholContentOptional" style={{ fontWeight: 400, fontSize: '0.92rem' }}>
                This product is exempt from stating alcohol content
              </label>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="netContentsMl">Net contents</label>
          <p className="hint">
            {authorized
              ? 'Authorized container sizes for this product type.'
              : 'Common container sizes. Malt beverages have no required sizes.'}
          </p>
          <select
            id="netContentsMl"
            value={showOther ? '__other__' : value.netContentsMl}
            onChange={(e) => {
              if (e.target.value === '__other__') {
                setOtherMode(true);
                set('netContentsMl', '');
              } else {
                setOtherMode(false);
                set('netContentsMl', e.target.value);
              }
            }}
          >
            <option value="">Not stated</option>
            {sizes.map((ml) => (
              <option key={ml} value={String(ml)}>
                {formatMl(ml)}
              </option>
            ))}
            <option value="__other__">Another size…</option>
          </select>

          {showOther && (
            <>
              <p className="hint" style={{ marginTop: 10 }}>
                In millilitres. Enter 750 for a 750 mL bottle.
              </p>
              <input
                id="netContentsMlOther"
                type="number"
                step="0.1"
                min="0"
                inputMode="decimal"
                aria-label="Net contents in millilitres"
                value={value.netContentsMl}
                onChange={(e) => set('netContentsMl', e.target.value)}
              />
              {authorized && value.netContentsMl !== '' && (
                <p className="hint" style={{ marginTop: 6, color: 'var(--review)' }}>
                  {formatMl(Number(value.netContentsMl))} is not an authorized size for this
                  product type. That is allowed here — the check will flag it against the label.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="bottlerNameAddress">Bottler name and address</label>
        <input
          id="bottlerNameAddress"
          type="text"
          value={value.bottlerNameAddress}
          onChange={(e) => set('bottlerNameAddress', e.target.value)}
        />
      </div>

      <div className="checkbox-row">
        <input
          id="isImport"
          type="checkbox"
          checked={value.isImport}
          onChange={(e) => set('isImport', e.target.checked)}
        />
        <label htmlFor="isImport">This is an imported product</label>
      </div>

      {value.isImport && (
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="countryOfOrigin">Country of origin</label>
          <input
            id="countryOfOrigin"
            type="text"
            value={value.countryOfOrigin}
            onChange={(e) => set('countryOfOrigin', e.target.value)}
          />
        </div>
      )}
    </fieldset>
  );
}
