import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
  FlatList,
} from "react-native";
import { useState, useEffect, useCallback } from "react";
import { Ionicons } from "@expo/vector-icons";
import { shoppingApi, recipesApi, ShoppingList, ShoppingListItem, Recipe } from "../../lib/api";

const CATEGORY_ICONS: Record<string, string> = {
  produce: "leaf-outline",
  protein: "fish-outline",
  dairy: "water-outline",
  pantry: "archive-outline",
  frozen: "snow-outline",
  spice: "color-palette-outline",
  beverage: "cafe-outline",
  other: "ellipsis-horizontal-outline",
};

const CATEGORY_COLORS: Record<string, string> = {
  produce: "#16a34a",
  protein: "#dc2626",
  dairy: "#2563eb",
  pantry: "#d97706",
  frozen: "#7c3aed",
  spice: "#db2777",
  beverage: "#0891b2",
  other: "#475569",
};

export default function ShoppingScreen() {
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [activeList, setActiveList] = useState<ShoppingList | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Recipe picker state
  const [pickerVisible, setPickerVisible] = useState(false);
  const [allRecipes, setAllRecipes] = useState<Recipe[]>([]);
  const [recipeSearch, setRecipeSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [listName, setListName] = useState("My Shopping List");
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await shoppingApi.list();
      setLists(data);
      if (data.length > 0) {
        const fresh = await shoppingApi.get(data[0].id);
        setActiveList(fresh);
      } else {
        setActiveList(null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openPicker = async () => {
    setSelectedIds(new Set());
    setRecipeSearch("");
    setListName("My Shopping List");
    setPickerVisible(true);
    try {
      const data = await recipesApi.list();
      setAllRecipes(data);
    } catch (e) {
      Alert.alert("Error", "Could not load recipes.");
    }
  };

  const toggleRecipe = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const generateFromRecipes = async () => {
    if (!selectedIds.size) { Alert.alert("Select at least one recipe."); return; }
    setGenerating(true);
    try {
      await shoppingApi.generateFromRecipes({
        recipe_ids: [...selectedIds],
        name: listName || "My Shopping List",
      });
      setPickerVisible(false);
      load();
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleToggle = async (item: ShoppingListItem) => {
    if (!activeList) return;
    const updated = !item.is_checked;
    setActiveList((prev) => {
      if (!prev) return prev;
      const newCats = { ...prev.items_by_category };
      for (const cat of Object.keys(newCats)) {
        newCats[cat] = newCats[cat].map((i) =>
          i.id === item.id ? { ...i, is_checked: updated } : i
        );
      }
      return { ...prev, items_by_category: newCats };
    });
    await shoppingApi.toggleItem(activeList.id, item.id, updated);
  };

  const handleDelete = async () => {
    if (!activeList) return;
    Alert.alert("Delete List", "Remove this shopping list?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { await shoppingApi.delete(activeList.id); load(); } },
    ]);
  };

  const onRefresh = () => { setRefreshing(true); load(); };

  const filteredRecipes = allRecipes.filter((r) =>
    r.title.toLowerCase().includes(recipeSearch.toLowerCase())
  );

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color="#f97316" size="large" /></View>;
  }

  return (
    <View style={styles.container}>
      {/* Header actions */}
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Shopping Lists</Text>
        <TouchableOpacity style={styles.fromRecipesBtn} onPress={openPicker}>
          <Ionicons name="restaurant-outline" size={15} color="#f97316" />
          <Text style={styles.fromRecipesBtnText}>From Recipes</Text>
        </TouchableOpacity>
      </View>

      {!activeList ? (
        <View style={styles.empty}>
          <Ionicons name="cart-outline" size={56} color="#334155" />
          <Text style={styles.emptyTitle}>No shopping lists</Text>
          <Text style={styles.emptySubtitle}>
            Tap "From Recipes" to build a list from specific recipes, or generate one from your meal plan.
          </Text>
        </View>
      ) : (
        <>
          {lists.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.listSelector}>
              {lists.map((l) => (
                <TouchableOpacity
                  key={l.id}
                  style={[styles.listTab, activeList.id === l.id && styles.listTabActive]}
                  onPress={async () => setActiveList(await shoppingApi.get(l.id))}
                >
                  <Text style={[styles.listTabText, activeList.id === l.id && styles.listTabTextActive]} numberOfLines={1}>
                    {l.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${Math.round((activeList.checked_count / (activeList.total_items || 1)) * 100)}%` }]} />
          </View>
          <View style={styles.progressRow}>
            <Text style={styles.progressText}>{activeList.checked_count} of {activeList.total_items} items</Text>
            <TouchableOpacity onPress={handleDelete}>
              <Ionicons name="trash-outline" size={18} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" />}>
            {Object.entries(activeList.items_by_category).map(([cat, items]) => (
              <View key={cat} style={styles.categoryBlock}>
                <View style={styles.categoryHeader}>
                  <Ionicons name={(CATEGORY_ICONS[cat] ?? "ellipsis-horizontal-outline") as any} size={16} color={CATEGORY_COLORS[cat] ?? "#475569"} />
                  <Text style={[styles.categoryTitle, { color: CATEGORY_COLORS[cat] ?? "#475569" }]}>
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </Text>
                  <Text style={styles.categoryCount}>{items.length}</Text>
                </View>
                {items.map((item) => (
                  <TouchableOpacity key={item.id} style={styles.itemRow} onPress={() => handleToggle(item)} activeOpacity={0.7}>
                    <View style={[styles.checkbox, item.is_checked && styles.checkboxChecked]}>
                      {item.is_checked && <Ionicons name="checkmark" size={14} color="#fff" />}
                    </View>
                    <Text style={[styles.itemText, item.is_checked && styles.itemTextChecked]}>{item.display_text}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ))}
          </ScrollView>
        </>
      )}

      {/* Recipe Picker Modal */}
      <Modal visible={pickerVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPickerVisible(false)}>
        <View style={styles.pickerContainer}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>Choose Recipes</Text>
            <TouchableOpacity onPress={() => setPickerVisible(false)}>
              <Ionicons name="close" size={24} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.pickerSearch}
            placeholder="Search recipes…"
            placeholderTextColor="#475569"
            value={recipeSearch}
            onChangeText={setRecipeSearch}
          />

          <FlatList
            data={filteredRecipes}
            keyExtractor={(r) => String(r.id)}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            renderItem={({ item }) => {
              const selected = selectedIds.has(item.id);
              return (
                <TouchableOpacity
                  style={[styles.pickerRow, selected && styles.pickerRowSelected]}
                  onPress={() => toggleRecipe(item.id)}
                  activeOpacity={0.7}
                >
                  <View style={[styles.pickerCheck, selected && styles.pickerCheckSelected]}>
                    {selected && <Ionicons name="checkmark" size={14} color="#f97316" />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerRecipeTitle} numberOfLines={1}>{item.title}</Text>
                    {item.meal_type && <Text style={styles.pickerMeta}>{item.meal_type}</Text>}
                  </View>
                </TouchableOpacity>
              );
            }}
          />

          <View style={styles.pickerFooter}>
            <Text style={styles.selectedCount}>
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : "None selected"}
            </Text>
            <TextInput
              style={[styles.pickerSearch, { flex: 1, marginBottom: 0 }]}
              placeholder="List name…"
              placeholderTextColor="#475569"
              value={listName}
              onChangeText={setListName}
            />
            <TouchableOpacity
              style={[styles.generateBtn, !selectedIds.size && { opacity: 0.4 }]}
              onPress={generateFromRecipes}
              disabled={generating || !selectedIds.size}
            >
              {generating
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.generateBtnText}>Generate List</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  center: { flex: 1, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  headerTitle: { color: "#f8fafc", fontSize: 20, fontWeight: "700" },
  fromRecipesBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#1e293b", paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: "#f97316" },
  fromRecipesBtnText: { color: "#f97316", fontSize: 13, fontWeight: "600" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyTitle: { color: "#f8fafc", fontSize: 20, fontWeight: "700", marginTop: 16 },
  emptySubtitle: { color: "#94a3b8", fontSize: 14, textAlign: "center", marginTop: 8, lineHeight: 20 },
  listSelector: { padding: 12, gap: 8 },
  listTab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: "#1e293b", maxWidth: 200 },
  listTabActive: { backgroundColor: "#f97316" },
  listTabText: { color: "#94a3b8", fontSize: 13 },
  listTabTextActive: { color: "#fff", fontWeight: "600" },
  progressBar: { height: 4, backgroundColor: "#1e293b", marginHorizontal: 16 },
  progressFill: { height: 4, backgroundColor: "#f97316", borderRadius: 2 },
  progressRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 },
  progressText: { color: "#64748b", fontSize: 13 },
  content: { padding: 12, gap: 12, paddingBottom: 32 },
  categoryBlock: { backgroundColor: "#1e293b", borderRadius: 12, overflow: "hidden" },
  categoryHeader: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, paddingBottom: 8 },
  categoryTitle: { fontSize: 14, fontWeight: "700", flex: 1 },
  categoryCount: { color: "#475569", fontSize: 12 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#0f172a" },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: "#334155", alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: "#16a34a", borderColor: "#16a34a" },
  itemText: { color: "#cbd5e1", fontSize: 15, flex: 1 },
  itemTextChecked: { color: "#334155", textDecorationLine: "line-through" },
  // Picker modal
  pickerContainer: { flex: 1, backgroundColor: "#0f172a" },
  pickerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "#1e293b" },
  pickerTitle: { color: "#f8fafc", fontSize: 18, fontWeight: "700" },
  pickerSearch: { backgroundColor: "#1e293b", color: "#f8fafc", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, margin: 12, marginBottom: 4, fontSize: 15 },
  pickerRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 10, backgroundColor: "#1e293b", borderWidth: 1, borderColor: "#334155" },
  pickerRowSelected: { borderColor: "#f97316", backgroundColor: "#2a1a0a" },
  pickerCheck: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: "#334155", alignItems: "center", justifyContent: "center" },
  pickerCheckSelected: { borderColor: "#f97316" },
  pickerRecipeTitle: { color: "#f8fafc", fontSize: 14, fontWeight: "500" },
  pickerMeta: { color: "#64748b", fontSize: 12, marginTop: 2 },
  pickerFooter: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: "#1e293b" },
  selectedCount: { color: "#64748b", fontSize: 13, minWidth: 70 },
  generateBtn: { backgroundColor: "#f97316", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  generateBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
