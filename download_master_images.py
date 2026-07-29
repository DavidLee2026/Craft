import hashlib, json, os, re, subprocess, sys, time, urllib.parse
from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
CACHE_DIR = DATA_DIR / "master_images"
MAPPING_FILE = DATA_DIR / "master_image_mapping.json"
MASTER_DIR = BASE_DIR.parent / "百科知识库" / "大师"

CACHE_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

DELAY = 5
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def url_to_hash(url):
    return hashlib.md5(url.encode()).hexdigest()


def extract_urls():
    """从 MD 文件提取所有图片 URL，返回 [(thumb_url, title, source_file), ...]"""
    m = {}
    for f in sorted(MASTER_DIR.glob("*.md")):
        src = f.name
        for t, u in re.findall(r"!\[([^\]]*)\]\((https?://[^\s)]+)\)", f.read_text()):
            if u not in m:
                m[u] = (t, src)
    return [(u, t, s) for u, (t, s) in m.items()]


def curl_post(url, data, timeout=15):
    r = subprocess.run([
        "curl", "-s", "--max-time", str(timeout),
        "-H", "User-Agent: " + UA,
        "-d", data, url
    ], capture_output=True, text=True, timeout=timeout + 10)
    if r.returncode == 0 and r.stdout:
        return r.stdout
    return None


def get_file_thumburl(file_title):
    data = "action=query&titles={}&prop=imageinfo&iiprop=url|size|mime&format=json&iiurlwidth=1200".format(
        urllib.parse.quote(file_title, safe='/:')
    )
    resp = curl_post("https://commons.wikimedia.org/w/api.php", data)
    if not resp:
        return None
    try:
        d = json.loads(resp)
        for pid, p in d.get("query", {}).get("pages", {}).items():
            if int(pid) < 0:
                return None
            if "imageinfo" in p and p["imageinfo"]:
                return p["imageinfo"][0].get("thumburl")
    except (json.JSONDecodeError, KeyError, ValueError):
        pass
    return None


def search_and_get_thumburl(search_term):
    data = "action=query&list=search&srsearch={}&srnamespace=6&srlimit=5&format=json".format(
        urllib.parse.quote(search_term)
    )
    resp = curl_post("https://commons.wikimedia.org/w/api.php", data)
    if not resp:
        return None
    try:
        d = json.loads(resp)
        results = d.get("query", {}).get("search", [])
        if not results:
            return None
        file_title = results[0]["title"]
        return get_file_thumburl(file_title)
    except (json.JSONDecodeError, KeyError, IndexError):
        pass
    return None


def curl_dl(url, path):
    r = subprocess.run([
        "curl", "-s", "-o", str(path), "-w", "%{http_code}",
        "--max-time", "60", "-H", "User-Agent: " + UA, "-L", url
    ], capture_output=True, text=True, timeout=90)
    c = r.stdout.strip()
    if c == "200" and path.exists() and path.stat().st_size > 2000:
        return True
    if path.exists():
        path.unlink()
    return False


# 搜索词映射：URL片段 -> [search_terms]
# 用 URL 中包含的文件名片段来区分同名图片
SEARCH_TERMS = {}

# 古典大师 (22-古典大师.md)
S = SEARCH_TERMS
S["Mona_Lisa"] = ["Mona Lisa Leonardo da Vinci"]
S["L%27ultima_cena"] = ["The Last Supper Leonardo da Vinci"]
S["Vitruvian_Man"] = ["Vitruvian Man Leonardo da Vinci"]
S["Sistine_chapel_ceiling"] = ["Sistine Chapel ceiling Michelangelo"]
S["David_sculpture"] = ["David Michelangelo sculpture"]
S["Creation_of_Adam"] = ["Creation of Adam Michelangelo Sistine"]
S["School_of_Athens"] = ["School of Athens Raphael"]
S["Sistine_Madonna"] = ["Sistine Madonna Raphael"]
S["Madonna_of_the_Meadow"] = ["Madonna of the Meadow Raphael"]
S["The_Night_Watch"] = ["The Night Watch Rembrandt"]
S["Rembrandt_Self-Portrait"] = ["Rembrandt self portrait 1659"]
S["Prodigal_Son"] = ["Return of the Prodigal Son Rembrandt"]
S["The_Milkmaid"] = ["The Milkmaid Vermeer"]
S["Pearl_Earring"] = ["Girl with a Pearl Earring Vermeer"]
S["The_Art_of_Painting"] = ["The Art of Painting Vermeer"]
S["Calling_of_St_Matthew"] = ["Calling of St Matthew Caravaggio"]
S["Calling_of_Saint_Matthew"] = ["The Calling of Saint Matthew Caravaggio"]
S["Bacchus_Caravaggio"] = ["Bacchus Caravaggio young"]
S["Erasmus_Holbein"] = ["Erasmus portrait Holbein"]
S["The_Ambassadors_Holbein"] = ["The Ambassadors Holbein"]

# 印象派大师 (23-印象派大师.md)
S["Impression%2C_Sunrise"] = ["Impression Sunrise Monet"]
S["Water_Lilies"] = ["Water Lilies Claude Monet"]
S["Rouen_Cathedral"] = ["Rouen Cathedral Monet"]
S["Moulin_de_la_Galette"] = ["Bal du moulin de la Galette Renoir"]
S["Luncheon_Boating_Party"] = ["Luncheon of the Boating Party Renoir"]
S["The_Umbrellas"] = ["The Umbrellas Renoir"]
S["Dance_Class"] = ["The Dance Class Degas"]
S["Petite_Danseuse"] = ["Little Dancer of Fourteen Years Degas"]
S["Degas_058"] = ["Degas ballet rehearsal"]
S["Dejeuner_sur_l%27herbe"] = ["Le Dejeuner sur l'herbe Manet"]
S["Olympia_Manet"] = ["Olympia Manet"]
S["The_Fifer"] = ["The Fifer Manet"]
S["Boulevard_Montmartre"] = ["Boulevard Montmartre Pissarro"]
S["Red_Roofs"] = ["Red Roofs Pissarro"]
S["Apple_Harvest"] = ["Apple Harvest Pissarro"]
S["Inondation_Port-Marly"] = ["Flood at Port-Marly Sisley"]
S["Church_at_Moret"] = ["Church at Moret Sisley"]
S["Bridge_at_Seine-et-Marne"] = ["Alfred Sisley Bridge Saint-Mammes", "The Bridge at Saint-Mammes Sisley"]
S["Child%27s_Bath"] = ["The Child's Bath Cassatt"]
S["Blue_Armchair"] = ["Little Girl in a Blue Armchair Cassatt"]
S["The_Tea_MET"] = ["The Tea Mary Cassatt"]

# 表现主义大师 (24-表现主义大师.md)
S["Starry_Night"] = ["The Starry Night Van Gogh"]
S["van_Gogh_127"] = ["Sunflowers Van Gogh"]
S["van_Gogh_-_Self-Portrait"] = ["Van Gogh Self-Portrait Google Art Project", "Vincent van Gogh self portrait 1889"]
S["The_Scream"] = ["The Scream Munch 1893", "Skrik Munch"]
S["Munch_Vampire"] = ["Vampire Munch The Kiss"]
S["Dance_of_Life"] = ["Dance of Life Munch"]
S["Schiele_-_Self-Portrait"] = ["Self-Portrait with Physalis Egon Schiele"]
S["Schiele_1917_-_Liebe"] = ["Egon Schiele Liebe Klappung 1917", "Schiele Umarmung Liebende"]
S["Schiele_1914"] = ["Sitzende Frau Egon Schiele"]
S["Klimt_016"] = ["The Kiss Klimt"]
S["drei_Lebensalter"] = ["Three Ages of Woman Klimt"]
S["Bloch-Bauer"] = ["Adele Bloch-Bauer Klimt portrait"]
S["Wind_Bride"] = ["The Wind Bride Oskar Kokoschka"]
S["Kokoschka_Self-Portrait"] = ["Oskar Kokoschka Self-Portrait"]
S["Kokoschka_-_London"] = ["London Oskar Kokoschka"]
S["Paseo_a_orillas"] = ["Paseo a orillas del mar Sorolla"]
S["Sorolla_-_Mujeres"] = ["Mujeres a orilla del mar Sorolla"]
S["La_ba%C3%B1era"] = ["Sorolla y Bastida bagnera", "Sorolla bath boys"]

# 现代大师 (25-现代大师.md)
S["Sainte-Victoire"] = ["Mont Sainte-Victoire Cezanne"]
S["Basket_of_Apples"] = ["The Basket of Apples Cezanne"]
S["Large_Bathers"] = ["The Large Bathers Cezanne"]
S["Morandi_natura_morta"] = ["Still Life Giorgio Morandi", "Natura morta Morandi"]
S["The_Dance_Matisse"] = ["The Dance Matisse"]
S["Red_Studio_Matisse"] = ["The Red Studio Matisse"]
S["Joy_of_Life"] = ["Le Bonheur de vivre Matisse", "Matisse Bonheur vivre 1905"]
S["Demoiselles_d%27Avignon"] = ["Les Demoiselles d'Avignon Picasso"]
S["Guernica"] = ["Guernica Picasso 1937", "Pablo Picasso Guernica oil painting"]
S["Weeping_Woman"] = ["Weeping Woman Picasso 1937 Tate", "Dora Maar Picasso weeping"]
S["Catalan_Landscape"] = ["Catalan Landscape Miro"]
S["The_Tilled_Field"] = ["Joan Miro The Tilled Field 1924", "La terre labourée Miro 1924"]
S["Harlequin_Carnival"] = ["Carnival of Harlequin Miro"]
S["Constellation_Miro"] = ["Constellation Miro"]
S["Duchamp_The_Spring"] = ["The Spring Duchamp"]
S["Nude_Descending"] = ["Nude Descending a Staircase Duchamp"]
S["Large_Glass"] = ["The Large Glass Duchamp"]
S["Orange_Red_Yellow"] = ["Orange Red Yellow Rothko"]
S["Rothko_painting"] = ["Rothko painting"]
S["Black_on_Grey"] = ["Black on Grey Rothko"]

# 当代与速写大师 (26-当代与速写大师.md)
S["Gondoliers%27_Siesta"] = ["Gondoliers Siesta Sargent"]
S["Sargent_Kerchief"] = ["The Kerchief Sargent"]
S["Sargent_Garden_Corfu"] = ["Garden Corfu Sargent"]
S["Menzel_eisernes"] = ["Iron Rolling Mill Menzel"]
S["Menzel_Bankett"] = ["Banquet Town Hall Menzel"]
S["Menzel_Gipsabguss"] = ["Plaster Cast Collection Menzel"]
S["Third-Class_Carriage"] = ["The Third-Class Carriage Daumier"]
S["Daumier_Gargantua"] = ["Gargantua Daumier"]
S["Daumier_036"] = ["Laundry woman Daumier"]
S["Kollwitz_Mutter"] = ["Mother with Dead Son Kollwitz"]
S["Brot_%21_Kollwitz"] = ["Brot Kaethe Kollwitz", "Kollwitz Brot print"]
S["Kollwitz_Selbstbildnis"] = ["Kaethe Kollwitz Selbstbildnis", "Käthe Kollwitz self portrait"]


def get_search_terms(thumb_url):
    """根据 URL 内容查找搜索词"""
    for key, terms in SEARCH_TERMS.items():
        if key in thumb_url:
            return terms
    return []


def main():
    urls = extract_urls()
    print("=" * 60, flush=True)
    print("Found {} images".format(len(urls)), flush=True)
    print("Strategy: Wikimedia Search -> Download (1200px)".format(), flush=True)
    print("=" * 60, flush=True)

    mapping = {}
    if MAPPING_FILE.exists():
        mapping = json.load(open(MAPPING_FILE, encoding="utf-8"))

    ok = skip = fail = 0
    failed_list = []

    for i, (thumb_url, title, src) in enumerate(urls, 1):
        h = url_to_hash(thumb_url)
        fp = CACHE_DIR / (h + ".jpg")

        if fp.exists() and fp.stat().st_size > 2000 and thumb_url in mapping:
            skip += 1
            continue

        print("[{}/{}] {} (from {})".format(i, len(urls), title, src), flush=True)

        # 获取搜索词
        terms = get_search_terms(thumb_url)
        if not terms:
            terms = [title]

        # 尝试搜索下载
        downloaded = False
        for term in terms:
            print("  search: '{}'...".format(term[:60]), end="", flush=True)
            thumb_dl_url = search_and_get_thumburl(term)
            if thumb_dl_url:
                if curl_dl(thumb_dl_url, fp):
                    sz = fp.stat().st_size / 1024
                    print(" OK ({}KB)".format(int(sz)), flush=True)
                    mapping[thumb_url] = h + ".jpg"
                    ok += 1
                    downloaded = True
                    break
                else:
                    print(" DL FAIL", flush=True)
            else:
                print(" not found", flush=True)
            time.sleep(1)

        if not downloaded:
            fail += 1
            failed_list.append("{} ({})".format(title, src))

        time.sleep(DELAY)

    # 保存映射
    with open(MAPPING_FILE, "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 60, flush=True)
    print("Done! OK={}, Skip={}, Fail={}".format(ok, skip, fail), flush=True)
    if failed_list:
        print("\nFailed ({}):".format(len(failed_list)), flush=True)
        for t in failed_list:
            print("  - {}".format(t), flush=True)


if __name__ == "__main__":
    main()
