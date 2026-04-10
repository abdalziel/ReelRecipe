// Central API client — update BASE_URL to match your backend host
// During development with Expo Go: use your machine's local IP, e.g. http://192.168.1.X:8000
// When running on simulator: http://localhost:8000 works

export const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000";

/** Convert a server-relative thumbnail path (e.g. /uploads/...) to a full URL. */
export function thumbnailUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (path.startsWith("http")) return path;
  return `${BASE_URL}${path}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail ?? "Request failed");
  }
  return res.json();
}

// ── Reels ──────────────────────────────────────────────────────────────────

export const reelsApi = {
  process: (url: string) =>
    request<Recipe>("/api/reels/process", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
};

// ── Recipes ────────────────────────────────────────────────────────────────

export const recipesApi = {
  list: (params?: { meal_type?: string; search?: string }) => {
    const q = new URLSearchParams(params as Record<string, string>);
    return request<Recipe[]>(`/api/recipes${q.size ? `?${q}` : ""}`);
  },
  get: (id: number) => request<Recipe>(`/api/recipes/${id}`),
  update: (id: number, data: Partial<Recipe>) =>
    request<Recipe>(`/api/recipes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: number) =>
    request<void>(`/api/recipes/${id}`, { method: "DELETE" }),
};

// ── Meal Plans ─────────────────────────────────────────────────────────────

export const mealPlanApi = {
  list: () => request<MealPlan[]>("/api/meal-plan"),
  create: (data: { name: string; week_start: string }) =>
    request<MealPlan>("/api/meal-plan", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  get: (id: number) => request<MealPlan>(`/api/meal-plan/${id}`),
  delete: (id: number) =>
    request<void>(`/api/meal-plan/${id}`, { method: "DELETE" }),
  addEntry: (planId: number, entry: MealPlanEntryCreate) =>
    request<MealPlanEntry>(`/api/meal-plan/${planId}/entries`, {
      method: "POST",
      body: JSON.stringify(entry),
    }),
  removeEntry: (planId: number, entryId: number) =>
    request<void>(`/api/meal-plan/${planId}/entries/${entryId}`, {
      method: "DELETE",
    }),
  aiAlign: (mealPlanId: number, dietPlanId: number) =>
    request<MealPlan>("/api/meal-plan/ai-align", {
      method: "POST",
      body: JSON.stringify({ meal_plan_id: mealPlanId, diet_plan_id: dietPlanId }),
    }),
};

// ── Shopping Lists ─────────────────────────────────────────────────────────

export const shoppingApi = {
  list: () => request<ShoppingList[]>("/api/shopping-lists"),
  get: (id: number) => request<ShoppingList>(`/api/shopping-lists/${id}`),
  generateFromPlan: (payload: { meal_plan_id: number; name?: string; grocery_runs?: number }) =>
    request<ShoppingList[]>("/api/shopping-lists/generate-from-plan", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  generateFromRecipes: (payload: { recipe_ids: number[]; name?: string }) =>
    request<ShoppingList>("/api/shopping-lists/generate-from-recipes", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  toggleItem: (listId: number, itemId: number, is_checked: boolean) =>
    request(`/api/shopping-lists/${listId}/items/${itemId}/toggle`, {
      method: "PATCH",
      body: JSON.stringify({ is_checked }),
    }),
  delete: (id: number) =>
    request<void>(`/api/shopping-lists/${id}`, { method: "DELETE" }),
};

// ── Instagram Bulk Import ──────────────────────────────────────────────────

export const instagramApi = {
  startBulkImport: (username: string, password: string, limit?: number) =>
    request<{ message: string; status: string }>("/api/instagram/bulk-import", {
      method: "POST",
      body: JSON.stringify({ username, password, limit }),
    }),
  getStatus: () => request<BulkImportStatus>("/api/instagram/bulk-import/status"),
  resetJob: () => request<void>("/api/instagram/bulk-import", { method: "DELETE" }),
};

// ── Diet Plans ─────────────────────────────────────────────────────────────

export const dietApi = {
  list: () => request<DietPlan[]>("/api/diet"),
  getActive: () => request<DietPlan>("/api/diet/active"),
  fromText: (description: string, name?: string) =>
    request<DietPlan>("/api/diet/from-text", {
      method: "POST",
      body: JSON.stringify({ description, name: name ?? "My Diet Plan" }),
    }),
  fromPdf: async (fileUri: string, name?: string) => {
    const formData = new FormData();
    formData.append("file", { uri: fileUri, name: "diet.pdf", type: "application/pdf" } as any);
    formData.append("name", name ?? "My Diet Plan");
    const res = await fetch(`${BASE_URL}/api/diet/from-pdf`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error("Failed to upload PDF");
    return res.json() as Promise<DietPlan>;
  },
  activate: (id: number) =>
    request<DietPlan>(`/api/diet/${id}/activate`, { method: "PATCH" }),
  delete: (id: number) =>
    request<void>(`/api/diet/${id}`, { method: "DELETE" }),
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface Ingredient {
  id?: number;
  name: string;
  quantity?: number;
  unit?: string;
  notes?: string;
  raw_text?: string;
  category?: string;
}

export interface Recipe {
  id: number;
  title: string;
  description?: string;
  source_url?: string;
  thumbnail_url?: string;
  servings: number;
  prep_time_minutes?: number;
  cook_time_minutes?: number;
  cuisine?: string;
  meal_type?: string;
  tags: string[];
  steps: string[];
  macros_per_serving: {
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
  };
  ingredients: Ingredient[];
  created_at: string;
}

export interface MealPlanEntryCreate {
  recipe_id: number;
  day_of_week: number;
  meal_slot: string;
  servings?: number;
}

export interface MealPlanEntry {
  id: number;
  day_of_week: number;
  meal_slot: string;
  servings: number;
  recipe: Pick<Recipe, "id" | "title" | "meal_type" | "thumbnail_url" | "macros_per_serving">;
}

export interface MealPlanDay {
  day: string;
  meals: Record<string, MealPlanEntry[]>;
}

export interface MealPlan {
  id: number;
  name: string;
  week_start: string;
  calendar: MealPlanDay[];
  created_at: string;
}

export interface ShoppingListItem {
  id: number;
  display_text: string;
  quantity?: number;
  unit?: string;
  category?: string;
  is_checked: boolean;
  ingredient_name: string;
}

export interface ShoppingList {
  id: number;
  name: string;
  grocery_run: number;
  meal_plan_id?: number;
  items_by_category: Record<string, ShoppingListItem[]>;
  total_items: number;
  checked_count: number;
  created_at: string;
}

export interface BulkImportStatus {
  status: "idle" | "running" | "done" | "error";
  total: number;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  current: string;
  log: string[];
  started_at?: string;
  finished_at?: string;
}

export interface DietPlan {
  id: number;
  name: string;
  is_active: boolean;
  source_type: string;
  diet_type?: string;
  daily_targets: {
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
  };
  meal_targets?: Record<string, { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number }>;
  restrictions: string[];
  goals?: string;
  analysis?: string;
  created_at: string;
}
