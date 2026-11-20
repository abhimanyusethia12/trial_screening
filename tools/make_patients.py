"""Generate synthetic FHIR R4 bundles for the sample patients.

All patients are fictional. Run: python3 tools/make_patients.py
"""
import base64
import json
import pathlib
import uuid

OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "patients"

SNOMED = "http://snomed.info/sct"
LOINC = "http://loinc.org"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"


def rid():
    return str(uuid.uuid4())


def patient(pid, given, family, gender, birth):
    return {
        "resourceType": "Patient",
        "id": pid,
        "name": [{"given": [given], "family": family, "text": f"{given} {family}"}],
        "gender": gender,
        "birthDate": birth,
        "meta": {"tag": [{"code": "synthetic", "display": "Synthetic test patient"}]},
    }


def condition(pid, code, display, onset):
    return {
        "resourceType": "Condition",
        "id": rid(),
        "subject": {"reference": f"Patient/{pid}"},
        "clinicalStatus": {"coding": [{"code": "active"}]},
        "code": {"coding": [{"system": SNOMED, "code": code, "display": display}], "text": display},
        "onsetDateTime": onset,
    }


def obs(pid, code, display, value, unit, date):
    return {
        "resourceType": "Observation",
        "id": rid(),
        "status": "final",
        "subject": {"reference": f"Patient/{pid}"},
        "code": {"coding": [{"system": LOINC, "code": code, "display": display}], "text": display},
        "valueQuantity": {"value": value, "unit": unit},
        "effectiveDateTime": date,
    }


def med(pid, code, display, start):
    return {
        "resourceType": "MedicationStatement",
        "id": rid(),
        "status": "active",
        "subject": {"reference": f"Patient/{pid}"},
        "medicationCodeableConcept": {"coding": [{"system": RXNORM, "code": code, "display": display}], "text": display},
        "effectivePeriod": {"start": start},
    }


def note(pid, title, date, text):
    return {
        "resourceType": "DocumentReference",
        "id": rid(),
        "status": "current",
        "subject": {"reference": f"Patient/{pid}"},
        "description": title,
        "date": date,
        "content": [{"attachment": {"contentType": "text/plain", "data": base64.b64encode(text.encode()).decode()}}],
    }


def bundle(resources):
    return {"resourceType": "Bundle", "type": "collection", "entry": [{"resource": r} for r in resources]}


def elena():
    p = "p-elena"
    return bundle([
        patient(p, "Elena", "Marsh", "female", "1972-03-14"),
        condition(p, "44054006", "Type 2 diabetes mellitus", "2019-05-02"),
        condition(p, "38341003", "Hypertension", "2017-09-10"),
        obs(p, "4548-4", "Hemoglobin A1c", 8.2, "%", "2026-10-28"),
        obs(p, "4548-4", "Hemoglobin A1c", 8.0, "%", "2026-04-22"),
        obs(p, "39156-5", "Body mass index", 33.4, "kg/m2", "2026-10-28"),
        obs(p, "29463-7", "Body weight", 92.1, "kg", "2026-08-01"),
        obs(p, "29463-7", "Body weight", 92.8, "kg", "2026-10-28"),
        obs(p, "62238-1", "eGFR (CKD-EPI)", 82, "mL/min/1.73m2", "2026-10-28"),
        obs(p, "9318-7", "Urine albumin/creatinine ratio", 18, "mg/g", "2026-10-28"),
        med(p, "6809", "Metformin 1000 mg twice daily", "2019-05-20"),
        med(p, "29046", "Lisinopril 10 mg daily", "2017-09-10"),
        note(p, "Annual diabetes review", "2026-10-28",
             "Annual diabetes review, 28 Oct 2026. Type 2 diabetes diagnosed 2019, on metformin 1000 mg twice daily "
             "with no dose change since 2024. No episodes of severe hypoglycemia; recognises hypoglycemia symptoms. "
             "Dilated eye exam June 2026: no diabetic retinopathy, no treatment needed. Denies history of pancreatitis. "
             "No gastrointestinal complaints. Family history: mother with hypothyroidism; no family history of thyroid "
             "cancer. No history of heart failure."),
    ])


def rahul():
    p = "p-rahul"
    return bundle([
        patient(p, "Rahul", "Venkat", "male", "1964-07-09"),
        condition(p, "44054006", "Type 2 diabetes mellitus", "2012-02-15"),
        condition(p, "127013003", "Diabetic nephropathy", "2021-06-01"),
        condition(p, "433144002", "Chronic kidney disease stage 3", "2021-06-01"),
        condition(p, "38341003", "Hypertension", "2010-03-03"),
        obs(p, "4548-4", "Hemoglobin A1c", 8.9, "%", "2026-09-15"),
        obs(p, "39156-5", "Body mass index", 28.9, "kg/m2", "2026-09-15"),
        obs(p, "29463-7", "Body weight", 88.0, "kg", "2026-06-20"),
        obs(p, "29463-7", "Body weight", 87.4, "kg", "2026-09-15"),
        obs(p, "62238-1", "eGFR (CKD-EPI)", 48, "mL/min/1.73m2", "2026-09-15"),
        obs(p, "9318-7", "Urine albumin/creatinine ratio", 1240, "mg/g", "2026-09-15"),
        med(p, "6809", "Metformin 500 mg twice daily", "2012-03-01"),
        med(p, "274783", "Insulin glargine 24 units nightly", "2018-01-10"),
        med(p, "1545653", "Empagliflozin 10 mg daily", "2022-02-01"),
        med(p, "29046", "Lisinopril 20 mg daily", "2010-03-03"),
        note(p, "Nephrology follow-up", "2026-09-15",
             "Nephrology follow-up, 15 Sep 2026. Long-standing type 2 diabetes (since 2012) with diabetic kidney "
             "disease; albuminuria attributed to diabetic nephropathy. Not on dialysis; no kidney transplant; never "
             "received immunosuppressive therapy. One episode of severe hypoglycemia in March 2026 requiring help from "
             "his wife after an insulin dose error. Father was diagnosed with medullary thyroid carcinoma at age 58. "
             "No history of pancreatitis. No hospital admissions in the past year."),
    ])


def maya():
    p = "p-maya"
    return bundle([
        patient(p, "Maya", "Okafor", "female", "1988-11-02"),
        condition(p, "414916001", "Obesity", "2020-01-15"),
        condition(p, "714628002", "Prediabetes", "2024-03-02"),
        condition(p, "78275009", "Obstructive sleep apnea", "2024-05-20"),
        obs(p, "4548-4", "Hemoglobin A1c", 6.0, "%", "2026-07-12"),
        obs(p, "39156-5", "Body mass index", 36.2, "kg/m2", "2026-10-05"),
        obs(p, "29463-7", "Body weight", 99.5, "kg", "2026-07-12"),
        obs(p, "29463-7", "Body weight", 98.9, "kg", "2026-10-05"),
        note(p, "Weight management consult", "2026-10-05",
             "Weight management consult, 5 Oct 2026. BMI 36.2. Completed a 6-month structured diet and walking "
             "programme in 2025 with less than 2 kg weight loss. No prior bariatric surgery or weight-loss devices, "
             "and none planned. Thyroid function normal; no endocrine cause of obesity identified. No personal or "
             "family history of thyroid cancer. No history of cancer. No history of pancreatitis. Diagnosed with "
             "obstructive sleep apnea in 2024, uses CPAP. HbA1c 6.0% in prediabetes range; no diabetes diagnosis."),
    ])


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in [("elena-marsh", elena), ("rahul-venkat", rahul), ("maya-okafor", maya)]:
        (OUT / f"{name}.json").write_text(json.dumps(fn(), indent=2))
        print("wrote", OUT / f"{name}.json")
