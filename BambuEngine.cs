using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml.Linq;

namespace BambuFilamentManager
{
    public class ParsedFilamentUsage
    {
        public int Index { get; set; }
        public string Type { get; set; }
        public string Color { get; set; }
        public double UsedGrams { get; set; }
        public double UsedMeters { get; set; }
        public string TrayInfoIdx { get; set; }
    }

    public class ParsedPrintFile
    {
        public string FileName { get; set; }
        public string PlateName { get; set; }
        public int PlateIndex { get; set; }
        public int PredictionSeconds { get; set; }
        public double TotalGrams { get; set; }
        public double TotalMeters { get; set; }
        public double FlushGrams { get; set; }
        public string ThumbnailBase64 { get; set; }
        public List<ParsedFilamentUsage> Filaments { get; set; }
        public string ParseSource { get; set; }
        public string Warning { get; set; }

        public ParsedPrintFile()
        {
            Filaments = new List<ParsedFilamentUsage>();
            PlateIndex = 1;
        }
    }

    public static class ThreeMfParser
    {
        public static ParsedPrintFile ParseMetadataFolder(string folderPath, string displayName)
        {
            var result = new ParsedPrintFile
            {
                FileName = displayName ?? Path.GetFileName(folderPath),
                PlateName = displayName ?? Path.GetFileName(folderPath),
                ParseSource = "bambu_studio_cache"
            };

            string metaDir = Directory.Exists(Path.Combine(folderPath, "Metadata"))
                ? Path.Combine(folderPath, "Metadata")
                : folderPath;

            string sliceInfoPath = Path.Combine(metaDir, "slice_info.config");
            if (File.Exists(sliceInfoPath))
            {
                ParseSliceInfoXml(File.ReadAllText(sliceInfoPath, Encoding.UTF8), result);
            }

            var gcodeFiles = Directory.GetFiles(metaDir, "plate_*.gcode", SearchOption.TopDirectoryOnly)
                .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (gcodeFiles.Count == 0)
            {
                gcodeFiles = Directory.GetFiles(metaDir, "*.gcode", SearchOption.TopDirectoryOnly).ToList();
            }

            if (gcodeFiles.Count > 0)
            {
                using (var fs = File.OpenRead(gcodeFiles[0]))
                {
                    string headerText = ReadGcodeHeader(fs, 450);
                    if (result.Filaments.Count == 0 || result.TotalGrams <= 0)
                    {
                        var gcodeParsed = ParseRawGcode(headerText, result.FileName);
                        if (gcodeParsed.Filaments.Count > 0)
                        {
                            result.Filaments = gcodeParsed.Filaments;
                            result.TotalGrams = gcodeParsed.TotalGrams;
                            result.TotalMeters = gcodeParsed.TotalMeters;
                            result.ParseSource = "bambu_studio_gcode";
                        }
                        if (result.PredictionSeconds <= 0 && gcodeParsed.PredictionSeconds > 0)
                            result.PredictionSeconds = gcodeParsed.PredictionSeconds;
                    }
                    var flushMatch = Regex.Match(headerText, @";\s*total\s+flush\s+weight\s*\[g\]\s*=\s*([0-9.]+)", RegexOptions.IgnoreCase);
                    if (flushMatch.Success)
                    {
                        double fg;
                        if (double.TryParse(flushMatch.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out fg))
                            result.FlushGrams = Math.Round(fg, 2);
                    }
                }
            }

            var pngFile = Directory.GetFiles(metaDir, "plate_*.png", SearchOption.TopDirectoryOnly)
                .Where(f => !f.Contains("no_light") && !f.Contains("small"))
                .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
            if (pngFile != null)
            {
                var fi = new FileInfo(pngFile);
                if (fi.Length > 0 && fi.Length < 2 * 1024 * 1024)
                {
                    result.ThumbnailBase64 = "data:image/png;base64," + Convert.ToBase64String(File.ReadAllBytes(pngFile));
                }
            }

            if (result.Filaments.Count > 0)
            {
                double sumG = result.Filaments.Sum(f => f.UsedGrams);
                double sumM = result.Filaments.Sum(f => f.UsedMeters);
                if (sumG > 0) result.TotalGrams = Math.Round(sumG, 2);
                if (sumM > 0) result.TotalMeters = Math.Round(sumM, 2);
            }

            return result;
        }

        public static ParsedPrintFile ParseFile(string filePath, string originalFileName)
        {
            string ext = Path.GetExtension(originalFileName ?? filePath ?? "").ToLowerInvariant();
            if (ext == ".gcode")
            {
                return ParseRawGcode(File.ReadAllText(filePath, Encoding.UTF8), originalFileName);
            }
            return Parse3mfArchive(filePath, originalFileName);
        }

        public static ParsedPrintFile ParseBytes(byte[] bytes, string originalFileName)
        {
            string tempFile = Path.Combine(Path.GetTempPath(), "bfm_" + Guid.NewGuid().ToString("N") + "_" + Path.GetFileName(originalFileName ?? "upload.3mf"));
            try
            {
                File.WriteAllBytes(tempFile, bytes);
                return ParseFile(tempFile, originalFileName);
            }
            finally
            {
                try { if (File.Exists(tempFile)) File.Delete(tempFile); } catch { }
            }
        }

        private static ParsedPrintFile Parse3mfArchive(string filePath, string originalFileName)
        {
            var result = new ParsedPrintFile
            {
                FileName = Path.GetFileName(originalFileName ?? filePath),
                PlateName = Path.GetFileNameWithoutExtension(originalFileName ?? filePath),
                ParseSource = "slice_info.config"
            };

            using (var archive = ZipFile.OpenRead(filePath))
            {
                // 1. Parse Metadata/slice_info.config
                var sliceInfoEntry = archive.Entries.FirstOrDefault(e =>
                    e.FullName.Equals("Metadata/slice_info.config", StringComparison.OrdinalIgnoreCase) ||
                    e.FullName.EndsWith("/slice_info.config", StringComparison.OrdinalIgnoreCase));

                if (sliceInfoEntry != null)
                {
                    using (var sr = new StreamReader(sliceInfoEntry.Open(), Encoding.UTF8))
                    {
                        string xmlText = sr.ReadToEnd();
                        ParseSliceInfoXml(xmlText, result);
                    }
                }

                // 2. Fallback / Supplement from Metadata/plate_*.gcode headers
                var gcodeEntry = archive.Entries
                    .Where(e => e.FullName.StartsWith("Metadata/plate_", StringComparison.OrdinalIgnoreCase) &&
                                e.FullName.EndsWith(".gcode", StringComparison.OrdinalIgnoreCase))
                    .OrderBy(e => e.FullName, StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();

                if (gcodeEntry == null)
                {
                    gcodeEntry = archive.Entries.FirstOrDefault(e => e.FullName.EndsWith(".gcode", StringComparison.OrdinalIgnoreCase));
                }

                if (gcodeEntry != null)
                {
                    string headerText = ReadGcodeHeader(gcodeEntry.Open(), 450);
                    if (result.Filaments.Count == 0 || result.TotalGrams <= 0)
                    {
                        var gcodeParsed = ParseRawGcode(headerText, result.FileName);
                        if (gcodeParsed.Filaments.Count > 0)
                        {
                            result.Filaments = gcodeParsed.Filaments;
                            result.TotalGrams = gcodeParsed.TotalGrams;
                            result.TotalMeters = gcodeParsed.TotalMeters;
                            result.ParseSource = "gcode_header";
                        }
                        if (result.PredictionSeconds <= 0 && gcodeParsed.PredictionSeconds > 0)
                        {
                            result.PredictionSeconds = gcodeParsed.PredictionSeconds;
                        }
                    }
                    // Extract flush weight if present in header
                    var flushMatch = Regex.Match(headerText, @";\s*total\s+flush\s+weight\s*\[g\]\s*=\s*([0-9.]+)", RegexOptions.IgnoreCase);
                    if (flushMatch.Success)
                    {
                        double fg;
                        if (double.TryParse(flushMatch.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out fg))
                        {
                            result.FlushGrams = Math.Round(fg, 2);
                        }
                    }
                }

                // 3. Extract thumbnail preview PNG (Metadata/plate_1.png or plate_N.png)
                var thumbEntry = archive.Entries
                    .Where(e => e.FullName.StartsWith("Metadata/plate_", StringComparison.OrdinalIgnoreCase) &&
                                e.FullName.EndsWith(".png", StringComparison.OrdinalIgnoreCase) &&
                                !e.FullName.Contains("no_light") && !e.FullName.Contains("small"))
                    .OrderBy(e => e.FullName, StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();

                if (thumbEntry == null)
                {
                    thumbEntry = archive.Entries.FirstOrDefault(e => e.FullName.EndsWith(".png", StringComparison.OrdinalIgnoreCase));
                }

                if (thumbEntry != null && thumbEntry.Length > 0 && thumbEntry.Length < 2 * 1024 * 1024)
                {
                    using (var ms = new MemoryStream())
                    using (var s = thumbEntry.Open())
                    {
                        s.CopyTo(ms);
                        result.ThumbnailBase64 = "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                    }
                }
            }

            if (result.Filaments.Count == 0 && result.TotalGrams <= 0)
            {
                result.Warning = "No sliced filament usage found. Make sure you export a SLICED .gcode.3mf (File > Export > Export plate sliced file) rather than an unsliced project .3mf.";
            }

            // Recompute totals cleanly
            if (result.Filaments.Count > 0)
            {
                double sumG = result.Filaments.Sum(f => f.UsedGrams);
                double sumM = result.Filaments.Sum(f => f.UsedMeters);
                if (sumG > 0) result.TotalGrams = Math.Round(sumG, 2);
                if (sumM > 0) result.TotalMeters = Math.Round(sumM, 2);
            }

            return result;
        }

        private static void ParseSliceInfoXml(string xmlText, ParsedPrintFile result)
        {
            try
            {
                var doc = XDocument.Parse(xmlText);
                var plates = doc.Descendants("plate").ToList();
                XElement targetPlate = plates.FirstOrDefault();

                if (targetPlate != null)
                {
                    foreach (var meta in targetPlate.Elements("metadata"))
                    {
                        string key = (string)meta.Attribute("key") ?? "";
                        string val = (string)meta.Attribute("value") ?? "";
                        if (key.Equals("index", StringComparison.OrdinalIgnoreCase))
                        {
                            int idx;
                            if (int.TryParse(val, out idx)) result.PlateIndex = idx;
                        }
                        else if (key.Equals("prediction", StringComparison.OrdinalIgnoreCase))
                        {
                            int sec;
                            if (int.TryParse(val, out sec)) result.PredictionSeconds = sec;
                        }
                        else if (key.Equals("weight", StringComparison.OrdinalIgnoreCase))
                        {
                            double w;
                            if (double.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out w))
                                result.TotalGrams = Math.Round(w, 2);
                        }
                    }

                    // Plate name from object if available
                    var firstObj = targetPlate.Elements("object").FirstOrDefault();
                    if (firstObj != null)
                    {
                        string objName = (string)firstObj.Attribute("name");
                        if (!string.IsNullOrWhiteSpace(objName)) result.PlateName = objName;
                    }

                    foreach (var fil in targetPlate.Elements("filament"))
                    {
                        int id = 1;
                        int.TryParse((string)fil.Attribute("id") ?? "1", out id);
                        string type = (string)fil.Attribute("type") ?? "PLA";
                        string color = NormalizeHexColor((string)fil.Attribute("color") ?? "#CCCCCC");
                        string trayInfoIdx = (string)fil.Attribute("tray_info_idx") ?? "";
                        double usedG = 0, usedM = 0;
                        double.TryParse((string)fil.Attribute("used_g") ?? "0", NumberStyles.Float, CultureInfo.InvariantCulture, out usedG);
                        double.TryParse((string)fil.Attribute("used_m") ?? "0", NumberStyles.Float, CultureInfo.InvariantCulture, out usedM);

                        if (usedG > 0.001 || usedM > 0.001)
                        {
                            result.Filaments.Add(new ParsedFilamentUsage
                            {
                                Index = id,
                                Type = type,
                                Color = color,
                                UsedGrams = Math.Round(usedG, 2),
                                UsedMeters = Math.Round(usedM, 2),
                                TrayInfoIdx = trayInfoIdx
                            });
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                result.Warning = "Partial XML parse warning: " + ex.Message;
            }
        }

        private static string ReadGcodeHeader(Stream stream, int maxLines)
        {
            var sb = new StringBuilder();
            using (var sr = new StreamReader(stream, Encoding.UTF8))
            {
                for (int i = 0; i < maxLines; i++)
                {
                    string line = sr.ReadLine();
                    if (line == null) break;
                    sb.AppendLine(line);
                }
            }
            return sb.ToString();
        }

        private static ParsedPrintFile ParseRawGcode(string text, string fileName)
        {
            var result = new ParsedPrintFile
            {
                FileName = Path.GetFileName(fileName ?? "print.gcode"),
                PlateName = Path.GetFileNameWithoutExtension(fileName ?? "print.gcode"),
                ParseSource = "gcode_header"
            };

            // Parse ; filament used [g] = 12.34, 5.67
            var gList = ParseCommaDoubles(text, @";\s*(?:total\s+)?filament\s+used\s*\[g\]\s*=\s*([^\r\n]+)");
            var mList = ParseCommaDoubles(text, @";\s*(?:total\s+)?filament\s+used\s*\[mm\]\s*=\s*([^\r\n]+)");
            var mMeters = ParseCommaDoubles(text, @";\s*(?:total\s+)?filament\s+used\s*\[m\]\s*=\s*([^\r\n]+)");
            var types = ParseSemiList(text, @";\s*filament_type\s*=\s*([^\r\n]+)");
            var colors = ParseSemiList(text, @";\s*filament_colour\s*=\s*([^\r\n]+)");

            // Single total fallback
            var totalGMatch = Regex.Match(text, @";\s*total\s+filament\s+weight\s*\[g\]\s*:\s*([0-9.,\s]+)", RegexOptions.IgnoreCase);
            if (gList.Count == 0 && totalGMatch.Success)
            {
                gList = SplitDoubles(totalGMatch.Groups[1].Value);
            }

            // Estimated printing time
            var timeMatch = Regex.Match(text, @";\s*(?:total\s+)?estimated\s+printing\s+time[^=]*=\s*([^\r\n]+)", RegexOptions.IgnoreCase);
            if (timeMatch.Success)
            {
                result.PredictionSeconds = ParseDurationString(timeMatch.Groups[1].Value);
            }

            int count = Math.Max(gList.Count, Math.Max(mMeters.Count, mList.Count));
            for (int i = 0; i < count; i++)
            {
                double ug = i < gList.Count ? gList[i] : 0;
                double um = i < mMeters.Count ? mMeters[i] : (i < mList.Count ? mList[i] / 1000.0 : 0);
                if (ug <= 0.001 && um <= 0.001) continue;

                // Estimate grams from meters if only meters present (~2.98g/m for 1.75mm PLA)
                if (ug <= 0.001 && um > 0) ug = Math.Round(um * 2.98, 2);
                if (um <= 0.001 && ug > 0) um = Math.Round(ug / 2.98, 2);

                result.Filaments.Add(new ParsedFilamentUsage
                {
                    Index = i + 1,
                    Type = i < types.Count && !string.IsNullOrWhiteSpace(types[i]) ? types[i] : "PLA",
                    Color = i < colors.Count && !string.IsNullOrWhiteSpace(colors[i]) ? NormalizeHexColor(colors[i]) : "#60A5FA",
                    UsedGrams = Math.Round(ug, 2),
                    UsedMeters = Math.Round(um, 2)
                });
            }

            result.TotalGrams = Math.Round(result.Filaments.Sum(f => f.UsedGrams), 2);
            result.TotalMeters = Math.Round(result.Filaments.Sum(f => f.UsedMeters), 2);
            return result;
        }

        private static List<double> ParseCommaDoubles(string text, string pattern)
        {
            var m = Regex.Match(text, pattern, RegexOptions.IgnoreCase);
            if (!m.Success) return new List<double>();
            return SplitDoubles(m.Groups[1].Value);
        }

        private static List<double> SplitDoubles(string raw)
        {
            var list = new List<double>();
            foreach (var part in raw.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                double v;
                if (double.TryParse(part.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v))
                    list.Add(v);
            }
            return list;
        }

        private static List<string> ParseSemiList(string text, string pattern)
        {
            var m = Regex.Match(text, pattern, RegexOptions.IgnoreCase);
            if (!m.Success) return new List<string>();
            return m.Groups[1].Value
                .Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Trim().Trim('"'))
                .ToList();
        }

        private static int ParseDurationString(string raw)
        {
            int total = 0;
            var d = Regex.Match(raw, @"(\d+)\s*d"); if (d.Success) total += int.Parse(d.Groups[1].Value) * 86400;
            var h = Regex.Match(raw, @"(\d+)\s*h"); if (h.Success) total += int.Parse(h.Groups[1].Value) * 3600;
            var m = Regex.Match(raw, @"(\d+)\s*m(?!s)"); if (m.Success) total += int.Parse(m.Groups[1].Value) * 60;
            var s = Regex.Match(raw, @"(\d+)\s*s"); if (s.Success) total += int.Parse(s.Groups[1].Value);
            return total;
        }

        public static string NormalizeHexColor(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return "#94A3B8";
            string c = raw.Trim().TrimStart('#');
            if (c.Length == 8) c = c.Substring(0, 6); // Strip Bambu RRGGBBAA alpha
            if (c.Length == 6 && Regex.IsMatch(c, "^[0-9A-Fa-f]{6}$"))
                return "#" + c.ToUpperInvariant();
            return "#94A3B8";
        }
    }

    public class FtpsFileInfo
    {
        public string Name { get; set; }
        public string Path { get; set; }
        public string Folder { get; set; }
        public long SizeBytes { get; set; }
        public string ModifiedRaw { get; set; }
        public long SortTicks { get; set; }
    }

    public static class BambuFtpsClient
    {
        public static List<FtpsFileInfo> ListPrintFiles(string ip, string accessCode, out string error)
        {
            error = null;
            var results = new List<FtpsFileInfo>();
            if (string.IsNullOrWhiteSpace(ip) || string.IsNullOrWhiteSpace(accessCode))
            {
                error = "Printer IP and Access Code are required.";
                return results;
            }

            // Step 1: Always list root "/" first using PASV (--disable-epsv) and discover which
            // subdirectories ACTUALLY exist on this printer (avoids curl (9) / 550 on P2S when /cache doesn't exist)
            var discoveredDirs = new List<string>();
            var skipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                ".", "..", "timelapse", "ipcam", "logger", "recorder", "image", "System Volume Information"
            };

            string rootOut, rootErr;
            int rootCode = RunCurl(
                string.Format("--silent --show-error --insecure --disable-epsv --connect-timeout 6 --max-time 15 --user \"bblp:{0}\" \"ftps://{1}:990/\"",
                    EscapeArg(accessCode), EscapeArg(ip)),
                out rootOut, out rootErr);

            if (rootCode != 0)
            {
                error = "Could not list P2S FTPS root '/': " + (string.IsNullOrWhiteSpace(rootErr) ? ("curl exit " + rootCode) : rootErr.Trim());
                return results;
            }

            ParseFtpListing("/", rootOut, results, discoveredDirs, skipDirs);

            // Step 2: Scan ONLY subdirectories that actually exist in "/" (e.g. cache, model, gcode)
            var errors = new List<string>();
            foreach (var subDir in discoveredDirs)
            {
                string folder = "/" + subDir.Trim('/') + "/";
                string stdout, stderr;
                int code = RunCurl(
                    string.Format("--silent --show-error --insecure --disable-epsv --connect-timeout 6 --max-time 15 --user \"bblp:{0}\" \"ftps://{1}:990{2}\"",
                        EscapeArg(accessCode), EscapeArg(ip), folder),
                    out stdout, out stderr);

                if (code != 0)
                {
                    if (!string.IsNullOrWhiteSpace(stderr)) errors.Add(folder + ": " + stderr.Trim());
                    continue;
                }

                ParseFtpListing(folder, stdout, results, null, skipDirs);
            }

            if (results.Count == 0)
            {
                if (discoveredDirs.Count == 0)
                {
                    error = "Connected to P2S FTPS (" + ip + ":990), but external USB storage '/' is empty. On the Bambu Lab P2S, prints sent to internal cache aren't exposed over FTPS—plug a FAT32 USB drive into the P2S (and save prints to External Storage), click 'From Bambu Studio', or drop a sliced .gcode.3mf file.";
                }
                else if (errors.Count > 0)
                {
                    error = string.Join(" | ", errors);
                }
            }

            // Sort newest first; prefer /cache/ on ties since Bambu caches active/recent prints there
            return results
                .OrderByDescending(r => r.SortTicks)
                .ThenBy(r => r.Folder.Equals("/cache/", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ToList();
        }

        private static void ParseFtpListing(string folder, string listingText, List<FtpsFileInfo> results, List<string> discoveredDirs, HashSet<string> skipDirs)
        {
            if (string.IsNullOrWhiteSpace(listingText)) return;
            foreach (var line in listingText.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                // Unix ls -l format: -rw-rw-rw- 1 root root 123456 Nov 22 10:15 myfile.gcode.3mf
                var match = Regex.Match(line, @"^([-drwxst]{10})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$");
                string perms = "";
                string name = null;
                long size = 0;
                string mod = "";

                if (match.Success)
                {
                    perms = match.Groups[1].Value;
                    long.TryParse(match.Groups[2].Value, out size);
                    mod = match.Groups[3].Value.Trim();
                    name = match.Groups[4].Value.Trim();
                }
                else
                {
                    string trimmed = line.Trim();
                    if (trimmed.EndsWith(".3mf", StringComparison.OrdinalIgnoreCase) ||
                        trimmed.EndsWith(".gcode", StringComparison.OrdinalIgnoreCase))
                    {
                        name = trimmed;
                    }
                }

                if (string.IsNullOrEmpty(name) || name == "." || name == "..") continue;

                if (perms.StartsWith("d") && discoveredDirs != null)
                {
                    if (!skipDirs.Contains(name) && !discoveredDirs.Contains(name))
                    {
                        discoveredDirs.Add(name);
                    }
                    continue;
                }

                if (name.EndsWith(".gcode.3mf", StringComparison.OrdinalIgnoreCase) ||
                    name.EndsWith(".3mf", StringComparison.OrdinalIgnoreCase) ||
                    name.EndsWith(".gcode", StringComparison.OrdinalIgnoreCase))
                {
                    string fullPath = folder + name;
                    if (!results.Any(r => r.Path.Equals(fullPath, StringComparison.OrdinalIgnoreCase)))
                    {
                        results.Add(new FtpsFileInfo
                        {
                            Name = name,
                            Path = fullPath,
                            Folder = folder,
                            SizeBytes = size,
                            ModifiedRaw = mod,
                            SortTicks = ParseFtpTimestampTicks(mod)
                        });
                    }
                }
            }
        }

        private static long ParseFtpTimestampTicks(string modRaw)
        {
            if (string.IsNullOrWhiteSpace(modRaw)) return 0;
            try
            {
                string cleaned = Regex.Replace(modRaw.Trim(), @"\s+", " ");
                DateTime dt;
                // Format A: "Nov 22 22:15" (current year)
                if (DateTime.TryParseExact(cleaned + " " + DateTime.Now.Year, "MMM d HH:mm yyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out dt))
                {
                    if (dt > DateTime.Now.AddDays(2)) dt = dt.AddYears(-1);
                    return dt.Ticks;
                }
                // Format B: "Nov 22 2025"
                if (DateTime.TryParseExact(cleaned, "MMM d yyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out dt))
                {
                    return dt.Ticks;
                }
            }
            catch { }
            return 0;
        }

        public static FtpsFileInfo FindMatchingFile(List<FtpsFileInfo> files, string gcodeFile, string subtaskName)
        {
            if (files == null || files.Count == 0) return null;
            string cleanGcode = Path.GetFileName((gcodeFile ?? "").Trim());
            string cleanSubtask = (subtaskName ?? "").Trim();

            if (!string.IsNullOrEmpty(cleanGcode))
            {
                var exact = files.FirstOrDefault(f => f.Name.Equals(cleanGcode, StringComparison.OrdinalIgnoreCase));
                if (exact != null) return exact;
                string stem = cleanGcode.Replace(".gcode.3mf", "").Replace(".3mf", "").Replace(".gcode", "");
                if (!string.IsNullOrEmpty(stem))
                {
                    var partial = files.FirstOrDefault(f => f.Name.IndexOf(stem, StringComparison.OrdinalIgnoreCase) >= 0);
                    if (partial != null) return partial;
                }
            }
            if (!string.IsNullOrEmpty(cleanSubtask))
            {
                var subMatch = files.FirstOrDefault(f => f.Name.IndexOf(cleanSubtask, StringComparison.OrdinalIgnoreCase) >= 0);
                if (subMatch != null) return subMatch;
            }
            return files[0];
        }

        public static bool UploadFile(string ip, string accessCode, string localFilePath, string remotePath, out string error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(ip) || string.IsNullOrWhiteSpace(accessCode))
            {
                error = "Printer IP and Access Code are required for FTPS upload.";
                return false;
            }
            if (!File.Exists(localFilePath))
            {
                error = "Local print file not found: " + localFilePath;
                return false;
            }

            string safePath = remotePath.StartsWith("/") ? remotePath : "/" + remotePath;
            string encodedPath = string.Join("/", safePath.Split('/').Select(seg => Uri.EscapeDataString(seg)));
            string stdout, stderr;
            int code = RunCurl(
                string.Format("--silent --show-error --insecure --disable-epsv --connect-timeout 8 --max-time 120 --user \"bblp:{0}\" --upload-file \"{1}\" \"ftps://{2}:990{3}\"",
                    EscapeArg(accessCode), localFilePath, EscapeArg(ip), encodedPath),
                out stdout, out stderr);

            if (code != 0)
            {
                error = string.IsNullOrWhiteSpace(stderr) ? ("FTPS upload failed (curl exit " + code + ").") : stderr.Trim();
                return false;
            }
            return true;
        }

        public static string ComputeFileMd5(string filePath)
        {
            if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath)) return "";
            using (var md5 = System.Security.Cryptography.MD5.Create())
            using (var fs = File.OpenRead(filePath))
            {
                byte[] hash = md5.ComputeHash(fs);
                return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            }
        }

        public static ParsedPrintFile DownloadAndParse(string ip, string accessCode, string remotePath, out string error)
        {
            error = null;
            string safePath = remotePath.StartsWith("/") ? remotePath : "/" + remotePath;
            string fileName = Path.GetFileName(safePath);
            string tempPath = Path.Combine(Path.GetTempPath(), "bfm_ftps_" + Guid.NewGuid().ToString("N") + "_" + fileName);

            try
            {
                string encodedPath = string.Join("/", safePath.Split('/').Select(seg => Uri.EscapeDataString(seg)));
                string stdout, stderr;
                int code = RunCurl(
                    string.Format("--silent --show-error --insecure --disable-epsv --connect-timeout 8 --max-time 60 --user \"bblp:{0}\" \"ftps://{1}:990{2}\" --output \"{3}\"",
                        EscapeArg(accessCode), EscapeArg(ip), encodedPath, tempPath),
                    out stdout, out stderr);

                if (code != 0 || !File.Exists(tempPath) || new FileInfo(tempPath).Length == 0)
                {
                    error = string.IsNullOrWhiteSpace(stderr) ? "FTPS download failed (exit code " + code + ")." : stderr.Trim();
                    return null;
                }

                return ThreeMfParser.ParseFile(tempPath, fileName);
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
            finally
            {
                try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            }
        }

        private static string EscapeArg(string s)
        {
            return (s ?? "").Replace("\"", "\\\"");
        }

        private static int RunCurl(string arguments, out string stdout, out string stderr)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "curl.exe",
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            using (var proc = Process.Start(psi))
            {
                stdout = proc.StandardOutput.ReadToEnd();
                stderr = proc.StandardError.ReadToEnd();
                proc.WaitForExit(65000);
                return proc.HasExited ? proc.ExitCode : -1;
            }
        }
    }

    public class LocalSlicerItem
    {
        public string Name { get; set; }
        public string FullPath { get; set; }
        public string Source { get; set; } // "Bambu Studio", "OrcaSlicer", "Downloads"
        public bool IsFolder { get; set; }
        public long SizeBytes { get; set; }
        public string ModifiedIso { get; set; }
        public long SortTicks { get; set; }
    }

    public static class LocalSlicerScanner
    {
        public static List<LocalSlicerItem> FindRecentSlicedPrints(int maxItems)
        {
            var items = new List<LocalSlicerItem>();
            string localTemp = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Temp");

            ScanTempModelRoot(Path.Combine(localTemp, "bamboo_model"), "Bambu Studio", items);
            ScanTempModelRoot(Path.Combine(localTemp, "orcaslicer_model"), "OrcaSlicer", items);

            string downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
            ScanArchiveFolder(downloads, "Downloads", items);

            string docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            ScanArchiveFolder(docs, "Documents", items);

            return items
                .OrderByDescending(i => i.SortTicks)
                .Take(Math.Max(1, maxItems))
                .ToList();
        }

        private static void ScanTempModelRoot(string rootDir, string sourceName, List<LocalSlicerItem> items)
        {
            if (string.IsNullOrEmpty(rootDir) || !Directory.Exists(rootDir)) return;
            try
            {
                foreach (var sliceFile in Directory.GetFiles(rootDir, "slice_info.config", SearchOption.AllDirectories))
                {
                    var fi = new FileInfo(sliceFile);
                    string metaDir = fi.DirectoryName;
                    string sessionDir = Path.GetFileName(metaDir).Equals("Metadata", StringComparison.OrdinalIgnoreCase)
                        ? Directory.GetParent(metaDir).FullName
                        : metaDir;

                    // Try reading object name quickly for friendlier display
                    string label = sourceName + " Plate (" + fi.LastWriteTime.ToString("MMM d HH:mm") + ")";
                    try
                    {
                        var doc = XDocument.Load(sliceFile);
                        var obj = doc.Descendants("object").FirstOrDefault();
                        if (obj != null && !string.IsNullOrWhiteSpace((string)obj.Attribute("name")))
                        {
                            label = (string)obj.Attribute("name");
                        }
                    }
                    catch { }

                    items.Add(new LocalSlicerItem
                    {
                        Name = label,
                        FullPath = sessionDir,
                        Source = sourceName,
                        IsFolder = true,
                        SizeBytes = fi.Length,
                        ModifiedIso = fi.LastWriteTimeUtc.ToString("o"),
                        SortTicks = fi.LastWriteTimeUtc.Ticks
                    });
                }
            }
            catch { }
        }

        private static void ScanArchiveFolder(string dir, string sourceName, List<LocalSlicerItem> items)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return;
            try
            {
                foreach (var fp in Directory.GetFiles(dir, "*.3mf", SearchOption.TopDirectoryOnly)
                    .Concat(Directory.GetFiles(dir, "*.gcode", SearchOption.TopDirectoryOnly)))
                {
                    var fi = new FileInfo(fp);
                    items.Add(new LocalSlicerItem
                    {
                        Name = fi.Name,
                        FullPath = fi.FullName,
                        Source = sourceName,
                        IsFolder = false,
                        SizeBytes = fi.Length,
                        ModifiedIso = fi.LastWriteTimeUtc.ToString("o"),
                        SortTicks = fi.LastWriteTimeUtc.Ticks
                    });
                }
            }
            catch { }
        }

        public static ParsedPrintFile ParseLocalItem(string path)
        {
            if (Directory.Exists(path))
            {
                return ThreeMfParser.ParseMetadataFolder(path, Path.GetFileName(path));
            }
            return ThreeMfParser.ParseFile(path, Path.GetFileName(path));
        }
    }

    public class CloudLoginResult
    {
        public bool Ok { get; set; }
        public bool NeedsVerificationCode { get; set; }
        public string Message { get; set; }
        public string AccessToken { get; set; }
        public string RefreshToken { get; set; }
        public string Uid { get; set; }
        public List<CloudDeviceInfo> Devices { get; set; }

        public CloudLoginResult() { Devices = new List<CloudDeviceInfo>(); }
    }

    public class CloudDeviceInfo
    {
        public string DevId { get; set; }
        public string Name { get; set; }
        public string ModelName { get; set; }
        public bool Online { get; set; }
        public string PrintStatus { get; set; }
    }

    public class CloudTaskInfo
    {
        public string Id { get; set; }
        public string DeviceId { get; set; }
        public string DeviceName { get; set; }
        public string Title { get; set; }
        public string DesignTitle { get; set; }
        public string Status { get; set; }
        public string StartTime { get; set; }
        public string EndTime { get; set; }
        public int CostTimeSeconds { get; set; }
        public double WeightGrams { get; set; }
        public double LengthMeters { get; set; }
        public string CoverUrl { get; set; }
        public ParsedPrintFile Parsed { get; set; }
        public List<string> MappingKeys { get; set; }

        public CloudTaskInfo() { MappingKeys = new List<string>(); }
    }

    public static class BambuCloudClient
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 20 * 1024 * 1024 };

        public static string GetApiBase(string region)
        {
            return (region ?? "").Equals("cn", StringComparison.OrdinalIgnoreCase)
                ? "https://api.bambulab.cn"
                : "https://api.bambulab.com";
        }

        public static string GetMqttHost(string region)
        {
            return (region ?? "").Equals("cn", StringComparison.OrdinalIgnoreCase)
                ? "cn.mqtt.bambulab.com"
                : "us.mqtt.bambulab.com";
        }

        public static CloudLoginResult Login(string region, string email, string password, string verifyCode)
        {
            var res = new CloudLoginResult();
            string apiBase = GetApiBase(region);
            try
            {
                var payloadObj = new Dictionary<string, object>();
                payloadObj["account"] = (email ?? "").Trim();
                if (!string.IsNullOrWhiteSpace(verifyCode))
                {
                    payloadObj["code"] = verifyCode.Trim();
                }
                else
                {
                    payloadObj["password"] = password ?? "";
                    payloadObj["apiError"] = "";
                }

                string respText;
                int code = CurlJson("POST", apiBase + "/v1/user-service/user/login", null, Json.Serialize(payloadObj), out respText);
                var data = TryParseDict(respText);

                if (data == null)
                {
                    if (!string.IsNullOrEmpty(respText) && (respText.IndexOf("cloudflare", StringComparison.OrdinalIgnoreCase) >= 0 || respText.IndexOf("403", StringComparison.OrdinalIgnoreCase) >= 0 || respText.IndexOf("<html", StringComparison.OrdinalIgnoreCase) >= 0))
                    {
                        res.Message = "Bambu Cloud API blocked automated login (Cloudflare 403). Switch to Local LAN Mode (works even while your P2S stays connected to Bambu Cloud) or paste your UID + Access Token + Serial Number for Cloud MQTT.";
                    }
                    else
                    {
                        res.Message = "Bambu Cloud returned an unreadable response (curl exit " + code + "): " + Truncate(respText, 180);
                    }
                    return res;
                }

                string accessToken = GetStr(data, "accessToken", "");
                string loginType = GetStr(data, "loginType", "");

                if (string.IsNullOrWhiteSpace(accessToken) &&
                    (loginType.Equals("verifyCode", StringComparison.OrdinalIgnoreCase) ||
                     GetStr(data, "message", "").IndexOf("verify", StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    // Trigger email verification code automatically
                    var sendPayload = new Dictionary<string, object>
                    {
                        { "email", (email ?? "").Trim() },
                        { "type", "codeLogin" }
                    };
                    string sendResp;
                    CurlJson("POST", apiBase + "/v1/user-service/user/sendemail/code", null, Json.Serialize(sendPayload), out sendResp);

                    res.NeedsVerificationCode = true;
                    res.Message = "Bambu Cloud emailed a 6-digit verification code to " + email + ". Enter it below to finish signing in.";
                    return res;
                }

                if (string.IsNullOrWhiteSpace(accessToken))
                {
                    string errMsg = GetStr(data, "error", GetStr(data, "message", "Login failed. Check email/password or verification code."));
                    res.Message = errMsg;
                    return res;
                }

                res.Ok = true;
                res.AccessToken = accessToken;
                res.RefreshToken = GetStr(data, "refreshToken", "");
                res.Uid = ResolveUid(region, accessToken);
                string devErr;
                res.Devices = GetBoundDevices(region, accessToken, out devErr);
                res.Message = "Signed in to Bambu Cloud" + (res.Devices.Count > 0 ? " (" + res.Devices.Count + " printer(s) found)." : ".");
                return res;
            }
            catch (Exception ex)
            {
                res.Message = ex.Message;
                return res;
            }
        }

        public static string ResolveUid(string region, string accessToken)
        {
            if (string.IsNullOrWhiteSpace(accessToken)) return "";
            string apiBase = GetApiBase(region);
            try
            {
                string respText;
                CurlJson("GET", apiBase + "/v1/design-user-service/my/preference", accessToken, null, out respText);
                var data = TryParseDict(respText);
                if (data != null)
                {
                    string uid = GetStr(data, "uid", "");
                    if (!string.IsNullOrWhiteSpace(uid)) return uid;
                }
            }
            catch { }

            // Fallback: decode JWT payload for username/sub
            try
            {
                string[] parts = accessToken.Split('.');
                if (parts.Length >= 2)
                {
                    string b64 = parts[1].Replace('-', '+').Replace('_', '/');
                    while (b64.Length % 4 != 0) b64 += "=";
                    string jwtJson = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
                    var claims = TryParseDict(jwtJson);
                    if (claims != null)
                    {
                        string u = GetStr(claims, "username", GetStr(claims, "sub", ""));
                        if (!string.IsNullOrWhiteSpace(u)) return u;
                    }
                }
            }
            catch { }
            return "";
        }

        public static List<CloudDeviceInfo> GetBoundDevices(string region, string accessToken, out string error)
        {
            error = null;
            var list = new List<CloudDeviceInfo>();
            if (string.IsNullOrWhiteSpace(accessToken))
            {
                error = "Bambu Cloud access token is required.";
                return list;
            }
            string apiBase = GetApiBase(region);
            string respText;
            int code = CurlJson("GET", apiBase + "/v1/iot-service/api/user/bind", accessToken, null, out respText);
            var data = TryParseDict(respText);
            if (data == null || !data.ContainsKey("devices"))
            {
                if (!string.IsNullOrEmpty(respText) && (respText.IndexOf("cloudflare", StringComparison.OrdinalIgnoreCase) >= 0 || respText.IndexOf("<html", StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    error = "Bambu Cloud API returned Cloudflare 403 (anti-bot block). Enter your Printer Serial Number and UID manually, or use Local LAN Mode.";
                }
                else
                {
                    error = data != null ? GetStr(data, "message", "Could not list bound printers.") : "Cloud request failed (curl " + code + ").";
                }
                return list;
            }

            var devs = AsList(data["devices"]);
            if (devs != null)
            {
                foreach (var dObj in devs)
                {
                    var d = dObj as Dictionary<string, object>;
                    if (d == null) continue;
                    list.Add(new CloudDeviceInfo
                    {
                        DevId = GetStr(d, "dev_id", ""),
                        Name = GetStr(d, "name", GetStr(d, "dev_id", "Bambu Printer")),
                        ModelName = GetStr(d, "dev_model_name", GetStr(d, "dev_product_name", "Bambu Lab")),
                        Online = d.ContainsKey("online") && Convert.ToBoolean(d["online"]),
                        PrintStatus = GetStr(d, "print_status", "")
                    });
                }
            }
            return list;
        }

        public static List<CloudTaskInfo> GetTasks(string region, string accessToken, string deviceId, int limit, out string error)
        {
            error = null;
            var list = new List<CloudTaskInfo>();
            if (string.IsNullOrWhiteSpace(accessToken))
            {
                error = "Sign in to Bambu Cloud first.";
                return list;
            }
            string apiBase = GetApiBase(region);
            string url = apiBase + "/v1/user-service/my/tasks?limit=" + Math.Max(1, Math.Min(limit, 50));
            if (!string.IsNullOrWhiteSpace(deviceId))
            {
                url += "&deviceId=" + Uri.EscapeDataString(deviceId.Trim());
            }

            string respText;
            int code = CurlJson("GET", url, accessToken, null, out respText);
            var data = TryParseDict(respText);
            if (data == null || !data.ContainsKey("hits"))
            {
                if (!string.IsNullOrEmpty(respText) && (respText.IndexOf("cloudflare", StringComparison.OrdinalIgnoreCase) >= 0 || respText.IndexOf("<html", StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    error = "Bambu Cloud task history API returned Cloudflare 403. Switch to Local LAN Mode to pull .gcode.3mf files directly from your P2S SD card (works without disabling Bambu Cloud on the printer).";
                }
                else
                {
                    error = data != null ? GetStr(data, "message", "Could not fetch Bambu Cloud print tasks.") : "Cloud request failed (curl " + code + ").";
                }
                return list;
            }

            var hits = AsList(data["hits"]);
            if (hits == null) return list;

            foreach (var hObj in hits)
            {
                var h = hObj as Dictionary<string, object>;
                if (h == null) continue;

                string title = GetStr(h, "title", "");
                string designTitle = GetStr(h, "designTitle", "");
                string displayName = !string.IsNullOrWhiteSpace(designTitle) ? designTitle : (!string.IsNullOrWhiteSpace(title) ? title : "Cloud Print Task");
                double totalWeight = GetDbl(h, "weight", 0);
                double totalLengthMm = GetDbl(h, "length", 0);
                double totalLengthM = totalLengthMm > 500 ? Math.Round(totalLengthMm / 1000.0, 2) : Math.Round(totalLengthMm, 2);
                int costTime = GetIntVal(h, "costTime", 0);
                string cover = GetStr(h, "cover", "");

                var parsed = new ParsedPrintFile
                {
                    FileName = !string.IsNullOrWhiteSpace(title) ? title : displayName,
                    PlateName = displayName,
                    PredictionSeconds = costTime,
                    TotalGrams = Math.Round(totalWeight, 2),
                    TotalMeters = totalLengthM,
                    ThumbnailBase64 = cover,
                    ParseSource = "bambu_cloud"
                };

                var mappingKeys = new List<string>();
                var amsDetails = AsList(h.ContainsKey("amsDetailMapping") ? h["amsDetailMapping"] : null);
                if (amsDetails != null && amsDetails.Count > 0)
                {
                    int idx = 1;
                    foreach (var aObj in amsDetails)
                    {
                        var a = aObj as Dictionary<string, object>;
                        if (a == null) continue;
                        double w = GetDbl(a, "weight", 0);
                        int amsId = GetIntVal(a, "amsId", -1);
                        int slotId = GetIntVal(a, "slotId", 0);
                        if (amsId < 0 && a.ContainsKey("ams"))
                        {
                            int flat = GetIntVal(a, "ams", -1);
                            if (flat >= 128) { amsId = flat; slotId = 0; }
                            else if (flat >= 0 && flat < 254) { amsId = flat / 4; slotId = flat % 4; }
                            else if (flat == 254 || flat == 255) { amsId = 254; slotId = 0; }
                        }

                        string slotKey = "";
                        if (amsId == 254 || amsId == 255) slotKey = "EXT";
                        else if (amsId >= 128) slotKey = "HT-" + ((amsId - 128) + 1);
                        else if (amsId >= 0) slotKey = ((char)('A' + Math.Min(amsId, 25))).ToString() + (slotId + 1);

                        string fType = GetStr(a, "filamentType", GetStr(a, "trayType", "PLA"));
                        string fColor = ThreeMfParser.NormalizeHexColor(GetStr(a, "targetColor", GetStr(a, "sourceColor", "#94A3B8")));

                        if (w > 0.001)
                        {
                            parsed.Filaments.Add(new ParsedFilamentUsage
                            {
                                Index = idx++,
                                Type = string.IsNullOrWhiteSpace(fType) ? "PLA" : fType,
                                Color = fColor,
                                UsedGrams = Math.Round(w, 2),
                                UsedMeters = Math.Round(w / 2.98, 2)
                            });
                            mappingKeys.Add(slotKey);
                        }
                    }
                }

                // If task only has a total weight without per-slot amsDetailMapping breakdown
                if (parsed.Filaments.Count == 0 && totalWeight > 0.001)
                {
                    parsed.Filaments.Add(new ParsedFilamentUsage
                    {
                        Index = 1,
                        Type = "PLA",
                        Color = "#00AE42",
                        UsedGrams = Math.Round(totalWeight, 2),
                        UsedMeters = totalLengthM > 0 ? totalLengthM : Math.Round(totalWeight / 2.98, 2)
                    });
                    mappingKeys.Add("");
                }

                if (parsed.Filaments.Count > 0)
                {
                    parsed.TotalGrams = Math.Round(parsed.Filaments.Sum(f => f.UsedGrams), 2);
                    if (parsed.TotalMeters <= 0) parsed.TotalMeters = Math.Round(parsed.Filaments.Sum(f => f.UsedMeters), 2);
                }

                list.Add(new CloudTaskInfo
                {
                    Id = GetStr(h, "id", ""),
                    DeviceId = GetStr(h, "deviceId", ""),
                    DeviceName = GetStr(h, "deviceName", ""),
                    Title = title,
                    DesignTitle = displayName,
                    Status = GetStr(h, "status", ""),
                    StartTime = GetStr(h, "startTime", ""),
                    EndTime = GetStr(h, "endTime", ""),
                    CostTimeSeconds = costTime,
                    WeightGrams = parsed.TotalGrams,
                    LengthMeters = parsed.TotalMeters,
                    CoverUrl = cover,
                    Parsed = parsed,
                    MappingKeys = mappingKeys
                });
            }

            return list;
        }

        private static int CurlJson(string method, string url, string bearerToken, string jsonBody, out string responseText)
        {
            string tempBodyFile = null;
            try
            {
                var args = new StringBuilder();
                args.Append("--silent --show-error --connect-timeout 10 --max-time 25 ");
                args.AppendFormat("-X {0} ", method);
                args.Append("-H \"Accept: application/json\" ");
                args.Append("-H \"User-Agent: bambu_network_agent/01.09.05.01\" ");
                args.Append("-H \"X-BBL-Client-Name: OrcaSlicer\" ");
                args.Append("-H \"X-BBL-Client-Type: slicer\" ");
                args.Append("-H \"X-BBL-Client-Version: 01.09.05.51\" ");

                if (!string.IsNullOrWhiteSpace(bearerToken))
                {
                    args.AppendFormat("-H \"Authorization: Bearer {0}\" ", bearerToken.Replace("\"", ""));
                }

                if (jsonBody != null)
                {
                    tempBodyFile = Path.Combine(Path.GetTempPath(), "bfm_cloud_" + Guid.NewGuid().ToString("N") + ".json");
                    File.WriteAllText(tempBodyFile, jsonBody, new UTF8Encoding(false));
                    args.Append("-H \"Content-Type: application/json\" ");
                    args.AppendFormat("--data-binary \"@{0}\" ", tempBodyFile);
                }

                args.AppendFormat("\"{0}\"", url);

                var psi = new ProcessStartInfo
                {
                    FileName = "curl.exe",
                    Arguments = args.ToString(),
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                using (var proc = Process.Start(psi))
                {
                    string stdout = proc.StandardOutput.ReadToEnd();
                    string stderr = proc.StandardError.ReadToEnd();
                    proc.WaitForExit(30000);
                    responseText = !string.IsNullOrWhiteSpace(stdout) ? stdout : stderr;
                    return proc.HasExited ? proc.ExitCode : -1;
                }
            }
            finally
            {
                if (tempBodyFile != null)
                {
                    try { if (File.Exists(tempBodyFile)) File.Delete(tempBodyFile); } catch { }
                }
            }
        }

        private static Dictionary<string, object> TryParseDict(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            try { return Json.Deserialize<Dictionary<string, object>>(s); } catch { return null; }
        }

        private static List<object> AsList(object val)
        {
            if (val == null || val is string) return null;
            var en = val as System.Collections.IEnumerable;
            if (en == null) return null;
            var res = new List<object>();
            foreach (var item in en) res.Add(item);
            return res;
        }

        private static string GetStr(Dictionary<string, object> d, string k, string defVal)
        {
            if (d == null || !d.ContainsKey(k) || d[k] == null) return defVal;
            return Convert.ToString(d[k], CultureInfo.InvariantCulture);
        }

        private static int GetIntVal(Dictionary<string, object> d, string k, int defVal)
        {
            int v;
            return int.TryParse(GetStr(d, k, ""), out v) ? v : defVal;
        }

        private static double GetDbl(Dictionary<string, object> d, string k, double defVal)
        {
            double v;
            return double.TryParse(GetStr(d, k, ""), NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : defVal;
        }

        private static string Truncate(string s, int maxLen)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= maxLen ? s : s.Substring(0, maxLen) + "...";
        }
    }

    public class LiveAmsTray
    {
        public int AmsId { get; set; }
        public int SlotId { get; set; }
        public string SlotKey { get; set; }
        public int State { get; set; }
        public string TrayType { get; set; }
        public string SubBrand { get; set; }
        public string TrayInfoIdx { get; set; }
        public string ProfileName { get; set; }
        public string ColorName { get; set; }
        public string Color { get; set; }
        public int NozzleTempMin { get; set; }
        public int NozzleTempMax { get; set; }
        public int BedTemp { get; set; }
        public string Diameter { get; set; }
        public int RemainPercent { get; set; }
        public bool HasRfid { get; set; }
        public string TrayUuid { get; set; }
        public string TagUid { get; set; }
        public double TrayWeight { get; set; }
        public bool IsEmpty { get; set; }
    }

    public class LiveAmsUnit
    {
        public int AmsId { get; set; }
        public string UnitType { get; set; } // "AMS 2 Pro", "AMS HT", "AMS"
        public string Label { get; set; }
        public double TempC { get; set; }
        public int HumidityLevel { get; set; }
        public int HumidityRaw { get; set; }
        public int DryTimeMinutes { get; set; }
        public List<LiveAmsTray> Trays { get; set; }

        public LiveAmsUnit()
        {
            Trays = new List<LiveAmsTray>();
        }
    }

    public class PrinterTelemetrySnapshot
    {
        public bool Connected { get; set; }
        public string ConnectionMode { get; set; } // "cloud" or "lan"
        public string StatusMessage { get; set; }
        public string LastError { get; set; }
        public string LastUpdateUtc { get; set; }
        public int MessagesReceived { get; set; }

        public string GcodeState { get; set; }
        public string SubtaskName { get; set; }
        public string GcodeFile { get; set; }
        public int McPercent { get; set; }
        public int RemainingMinutes { get; set; }
        public int LayerNum { get; set; }
        public int TotalLayerNum { get; set; }
        public double NozzleTemp { get; set; }
        public double BedTemp { get; set; }
        public double ChamberTemp { get; set; }
        public string ActiveTrayNow { get; set; }

        public List<string> AmsMappingKeys { get; set; }
        public List<int> AmsMapping { get; set; }
        public List<LiveAmsUnit> AmsUnits { get; set; }
        public LiveAmsTray ExternalTray { get; set; }

        public string LastCommandResult { get; set; }
        public string LastCommandReason { get; set; }
        public string LastCommandAtUtc { get; set; }

        // Pending finished job alert for auto-deduction
        public string LastFinishedJobId { get; set; }
        public string LastFinishedFileName { get; set; }
        public string LastFinishedState { get; set; }
        public int LastFinishedPercent { get; set; }
        public List<int> LastFinishedMapping { get; set; }
        public List<string> LastFinishedMappingKeys { get; set; }
        public string LastFinishedAtUtc { get; set; }

        public PrinterTelemetrySnapshot()
        {
            StatusMessage = "Disconnected";
            GcodeState = "IDLE";
            AmsMapping = new List<int>();
            AmsMappingKeys = new List<string>();
            AmsUnits = new List<LiveAmsUnit>();
            LastFinishedMapping = new List<int>();
            LastFinishedMappingKeys = new List<string>();
        }
    }

    public class BambuMqttClient : IDisposable
    {
        private readonly object _lock = new object();
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = 10 * 1024 * 1024 };

        private Thread _workerThread;
        private volatile bool _running;
        private TcpClient _tcp;
        private SslStream _ssl;

        private string _host;
        private string _username;
        private string _password;
        private string _serial;
        private string _mode = "cloud";
        private bool _ignoreCertErrors = true;

        private PrinterTelemetrySnapshot _state = new PrinterTelemetrySnapshot();
        private string _prevGcodeState = "";
        private string _activeJobFile = "";
        private string _activeJobSubtask = "";
        private int _activeJobMaxPercent = 0;
        private List<int> _activeJobMapping = new List<int>();
        private List<string> _activeJobMappingKeys = new List<string>();
        private DateTime _lastPingUtc = DateTime.UtcNow;

        public void ConfigureAndConnect(string ip, string serial, string accessCode)
        {
            Disconnect();
            if (string.IsNullOrWhiteSpace(ip) || string.IsNullOrWhiteSpace(serial) || string.IsNullOrWhiteSpace(accessCode))
            {
                lock (_lock)
                {
                    _state.Connected = false;
                    _state.ConnectionMode = "lan";
                    _state.StatusMessage = "Not configured";
                    _state.LastError = "Provide LAN IP, Serial Number, and Access Code.";
                }
                return;
            }

            _mode = "lan";
            _host = ip.Trim();
            _username = "bblp";
            _password = accessCode.Trim();
            _serial = serial.Trim().ToUpperInvariant();
            _ignoreCertErrors = true;
            StartWorker("Connecting to P2S LAN (" + _host + ":8883)...");
        }

        public void ConfigureAndConnectCloud(string region, string uid, string accessToken, string serial)
        {
            Disconnect();
            if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(accessToken) || string.IsNullOrWhiteSpace(serial))
            {
                lock (_lock)
                {
                    _state.Connected = false;
                    _state.ConnectionMode = "cloud";
                    _state.StatusMessage = "Not signed in";
                    _state.LastError = "Sign in to Bambu Cloud and select your printer serial number.";
                }
                return;
            }

            _mode = "cloud";
            _host = BambuCloudClient.GetMqttHost(region);
            string cleanUid = uid.Trim();
            _username = cleanUid.StartsWith("u_", StringComparison.OrdinalIgnoreCase) ? cleanUid : ("u_" + cleanUid);
            _password = accessToken.Trim();
            _serial = serial.Trim().ToUpperInvariant();
            _ignoreCertErrors = false;
            StartWorker("Connecting to Bambu Cloud (" + _host + ":8883)...");
        }

        private void StartWorker(string initialMsg)
        {
            _running = true;
            lock (_lock)
            {
                _state.Connected = false;
                _state.ConnectionMode = _mode;
                _state.StatusMessage = initialMsg;
                _state.LastError = null;
            }

            _workerThread = new Thread(RunLoop) { IsBackground = true, Name = "BambuMqttWorker" };
            _workerThread.Start();
        }

        public void Disconnect()
        {
            _running = false;
            CloseSocket();
            if (_workerThread != null && _workerThread.IsAlive)
            {
                try { _workerThread.Join(1500); } catch { }
            }
            lock (_lock)
            {
                _state.Connected = false;
                _state.StatusMessage = "Disconnected";
            }
        }

        public void RequestPushAll()
        {
            if (!_running || _ssl == null) return;
            try
            {
                string topic = "device/" + _serial + "/request";
                string payload = "{\"pushing\":{\"sequence_id\":\"0\",\"command\":\"pushall\",\"version\":1,\"push_target\":1}}";
                SendPublish(topic, payload);
            }
            catch { }
        }

        public string BuildProjectFilePayload(
            string remotePath,
            string subtaskName,
            int plateIndex,
            bool useAms,
            List<string> slotKeysByFilamentIndex,
            bool bedLeveling,
            bool flowCali,
            bool vibrationCali,
            bool layerInspect,
            bool timelapse,
            string urlScheme,
            string md5Hex)
        {
            string cleanRel = (remotePath ?? "").TrimStart('/');
            string fileName = Path.GetFileName(cleanRel);
            string url = (urlScheme ?? "ftp").Equals("sdcard", StringComparison.OrdinalIgnoreCase)
                ? ("file:///sdcard/" + cleanRel)
                : ("ftp:///" + cleanRel);

            var flatMap = new List<int>();
            var map2 = new List<Dictionary<string, object>>();

            if (slotKeysByFilamentIndex != null)
            {
                foreach (var sk in slotKeysByFilamentIndex)
                {
                    int amsId, slotId, flatIdx;
                    ParseSlotKey(sk, out amsId, out slotId, out flatIdx);
                    flatMap.Add(flatIdx);
                    map2.Add(new Dictionary<string, object>
                    {
                        { "ams_id", amsId },
                        { "slot_id", slotId }
                    });
                }
            }

            string seq = DateTime.UtcNow.Ticks.ToString().Substring(8);
            var printCmd = new Dictionary<string, object>
            {
                { "sequence_id", seq },
                { "command", "project_file" },
                { "param", "Metadata/plate_" + Math.Max(1, plateIndex) + ".gcode" },
                { "subtask_name", string.IsNullOrWhiteSpace(subtaskName) ? Path.GetFileNameWithoutExtension(fileName) : subtaskName },
                { "file", fileName },
                { "url", url },
                { "timelapse", timelapse },
                { "bed_type", "auto" },
                { "bed_levelling", bedLeveling },
                { "bed_leveling", bedLeveling },
                { "flow_cali", flowCali },
                { "vibration_cali", vibrationCali },
                { "layer_inspect", layerInspect },
                { "use_ams", useAms },
                { "profile_id", "0" },
                { "project_id", "0" },
                { "subtask_id", "0" },
                { "task_id", "0" }
            };

            if (!string.IsNullOrWhiteSpace(md5Hex))
            {
                printCmd["md5"] = md5Hex;
            }
            if (useAms && flatMap.Count > 0)
            {
                printCmd["ams_mapping"] = flatMap;
                printCmd["ams_mapping2"] = map2;
            }

            var root = new Dictionary<string, object> { { "print", printCmd } };
            return _json.Serialize(root);
        }

        public bool StartPrintJob(
            string remotePath,
            string subtaskName,
            int plateIndex,
            bool useAms,
            List<string> slotKeysByFilamentIndex,
            bool bedLeveling,
            bool flowCali,
            bool vibrationCali,
            bool layerInspect,
            bool timelapse,
            string urlScheme,
            string md5Hex,
            out string payloadOut,
            out string error)
        {
            error = null;
            payloadOut = BuildProjectFilePayload(
                remotePath, subtaskName, plateIndex, useAms, slotKeysByFilamentIndex,
                bedLeveling, flowCali, vibrationCali, layerInspect, timelapse, urlScheme, md5Hex);

            if (!_running || _ssl == null || !_state.Connected)
            {
                error = "Printer is not connected over MQTT. Connect to your P2S first.";
                return false;
            }

            try
            {
                lock (_lock)
                {
                    _state.LastCommandResult = "SENT";
                    _state.LastCommandReason = "Waiting for P2S response...";
                    _state.LastCommandAtUtc = DateTime.UtcNow.ToString("o");
                }
                string topic = "device/" + _serial + "/request";
                SendPublish(topic, payloadOut);
                return true;
            }
            catch (Exception ex)
            {
                error = "Failed to publish MQTT print command: " + ex.Message;
                return false;
            }
        }

        public bool SendPrintControl(string action, out string error)
        {
            error = null;
            string cmd = (action ?? "").Trim().ToLowerInvariant();
            if (cmd != "pause" && cmd != "resume" && cmd != "stop")
            {
                error = "Unsupported control action: " + action;
                return false;
            }
            if (!_running || _ssl == null || !_state.Connected)
            {
                error = "Printer is not connected over MQTT.";
                return false;
            }
            try
            {
                string seq = DateTime.UtcNow.Ticks.ToString().Substring(8);
                string payload = "{\"print\":{\"sequence_id\":\"" + seq + "\",\"command\":\"" + cmd + "\",\"param\":\"\"}}";
                SendPublish("device/" + _serial + "/request", payload);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static void ParseSlotKey(string slotKey, out int amsId, out int slotId, out int flatIdx)
        {
            string s = (slotKey ?? "").Trim().ToUpperInvariant();
            if (string.IsNullOrEmpty(s) || s == "VAULT")
            {
                amsId = -1; slotId = -1; flatIdx = -1; return;
            }
            if (s == "EXT")
            {
                amsId = 254; slotId = 0; flatIdx = 254; return;
            }
            if (s.StartsWith("HT-"))
            {
                int n = 1;
                int.TryParse(s.Substring(3), out n);
                amsId = 128 + Math.Max(0, n - 1);
                slotId = 0;
                flatIdx = amsId;
                return;
            }
            if (s.Length >= 2 && s[0] >= 'A' && s[0] <= 'Z')
            {
                amsId = s[0] - 'A';
                int sl = 1;
                int.TryParse(s.Substring(1), out sl);
                slotId = Math.Max(0, Math.Min(3, sl - 1));
                flatIdx = amsId * 4 + slotId;
                return;
            }
            amsId = -1; slotId = -1; flatIdx = -1;
        }

        public PrinterTelemetrySnapshot GetSnapshot()
        {
            lock (_lock)
            {
                string serialized = _json.Serialize(_state);
                return _json.Deserialize<PrinterTelemetrySnapshot>(serialized);
            }
        }

        public void ClearLastFinishedJob(string jobId)
        {
            lock (_lock)
            {
                if (_state.LastFinishedJobId == jobId)
                {
                    _state.LastFinishedJobId = null;
                }
            }
        }

        private void CloseSocket()
        {
            try { if (_ssl != null) _ssl.Close(); } catch { }
            try { if (_tcp != null) _tcp.Close(); } catch { }
            _ssl = null;
            _tcp = null;
        }

        private void RunLoop()
        {
            while (_running)
            {
                try
                {
                    lock (_lock)
                    {
                        _state.ConnectionMode = _mode;
                        _state.StatusMessage = (_mode == "cloud" ? "Connecting to Bambu Cloud (" : "Connecting to P2S LAN (") + _host + ":8883)...";
                        _state.LastError = null;
                    }

                    _tcp = new TcpClient();
                    var connectTask = _tcp.BeginConnect(_host, 8883, null, null);
                    if (!connectTask.AsyncWaitHandle.WaitOne(TimeSpan.FromSeconds(8)))
                    {
                        throw new TimeoutException("Connection timed out to " + _host + ":8883.");
                    }
                    _tcp.EndConnect(connectTask);
                    _tcp.ReceiveTimeout = 2000;
                    _tcp.SendTimeout = 5000;

                    _ssl = new SslStream(_tcp.GetStream(), false,
                        (sender, cert, chain, errors) => _ignoreCertErrors || errors == SslPolicyErrors.None);

                    _ssl.AuthenticateAsClient(_host, null, SslProtocols.Tls12, false);

                    SendConnect("bfm_" + Guid.NewGuid().ToString("N").Substring(0, 10), _username, _password, 45);

                    // Wait for CONNACK
                    byte[] connAck = ReadPacket(5000);
                    if (connAck == null || (connAck[0] >> 4) != 2 || connAck.Length < 4 || connAck[3] != 0)
                    {
                        int rc = (connAck != null && connAck.Length >= 4) ? connAck[3] : -1;
                        string reason = rc == 4 || rc == 5
                            ? (_mode == "cloud" ? "Bambu Cloud MQTT auth failed (token expired or invalid UID)" : "Authentication failed (check Access Code)")
                            : "Broker rejected connection (code " + rc + ")";
                        throw new Exception(reason);
                    }

                    // Subscribe to device/{serial}/report
                    SendSubscribe(1, "device/" + _serial + "/report");

                    lock (_lock)
                    {
                        _state.Connected = true;
                        _state.ConnectionMode = _mode;
                        _state.StatusMessage = _mode == "cloud" ? ("Connected via Bambu Cloud (" + _host + ")") : ("Connected to P2S LAN (" + _host + ")");
                        _state.LastError = null;
                    }

                    // Ask printer for full status dump immediately
                    RequestPushAll();
                    _lastPingUtc = DateTime.UtcNow;

                    while (_running && _tcp != null && _tcp.Connected)
                    {
                        if ((DateTime.UtcNow - _lastPingUtc).TotalSeconds >= 25)
                        {
                            SendPingReq();
                            _lastPingUtc = DateTime.UtcNow;
                        }

                        byte[] packet = ReadPacket(2000);
                        if (packet == null) continue;

                        int packetType = packet[0] >> 4;
                        if (packetType == 3) // PUBLISH
                        {
                            HandlePublishPacket(packet);
                        }
                        else if (packetType == 13) // PINGRESP
                        {
                            // healthy
                        }
                    }
                }
                catch (Exception ex)
                {
                    lock (_lock)
                    {
                        _state.Connected = false;
                        _state.StatusMessage = "Reconnecting...";
                        _state.LastError = ex.Message;
                    }
                    CloseSocket();
                    if (_running) Thread.Sleep(5000);
                }
            }
            CloseSocket();
        }

        private void HandlePublishPacket(byte[] packet)
        {
            int idx = 1;
            int remLen = DecodeRemainingLength(packet, ref idx);
            if (idx + 2 > packet.Length) return;

            int topicLen = (packet[idx] << 8) | packet[idx + 1];
            idx += 2;
            if (idx + topicLen > packet.Length) return;
            idx += topicLen;

            int qos = (packet[0] >> 1) & 0x03;
            if (qos > 0)
            {
                if (idx + 2 > packet.Length) return;
                idx += 2; // packet identifier
            }

            int payloadLen = packet.Length - idx;
            if (payloadLen <= 0) return;

            string jsonStr = Encoding.UTF8.GetString(packet, idx, payloadLen);
            ParseBambuReportJson(jsonStr);
        }

        private void ParseBambuReportJson(string jsonStr)
        {
            try
            {
                var root = _json.Deserialize<Dictionary<string, object>>(jsonStr);
                if (root == null || !root.ContainsKey("print")) return;
                var print = root["print"] as Dictionary<string, object>;
                if (print == null) return;

                lock (_lock)
                {
                    _state.MessagesReceived++;
                    _state.LastUpdateUtc = DateTime.UtcNow.ToString("o");

                    string newGcodeState = GetString(print, "gcode_state", _state.GcodeState);
                    string subtask = GetString(print, "subtask_name", _state.SubtaskName);
                    string gcodeFile = GetString(print, "gcode_file", _state.GcodeFile);
                    int mcPercent = GetInt(print, "mc_percent", _state.McPercent);

                    _state.GcodeState = newGcodeState;
                    _state.SubtaskName = subtask;
                    _state.GcodeFile = gcodeFile;
                    _state.McPercent = mcPercent;
                    _state.RemainingMinutes = GetInt(print, "mc_remaining_time", _state.RemainingMinutes);
                    _state.LayerNum = GetInt(print, "layer_num", _state.LayerNum);
                    _state.TotalLayerNum = GetInt(print, "total_layer_num", _state.TotalLayerNum);
                    _state.NozzleTemp = GetDouble(print, "nozzle_temper", _state.NozzleTemp);
                    _state.BedTemp = GetDouble(print, "bed_temper", _state.BedTemp);
                    _state.ChamberTemp = GetDouble(print, "chamber_temper", _state.ChamberTemp);

                    // Capture command acknowledgment / errors (e.g., project_file result/reason)
                    if (print.ContainsKey("command") && print.ContainsKey("result"))
                    {
                        string cmdName = GetString(print, "command", "");
                        if (cmdName == "project_file" || cmdName == "pause" || cmdName == "resume" || cmdName == "stop")
                        {
                            _state.LastCommandResult = GetString(print, "result", "");
                            string rsn = GetString(print, "reason", "");
                            int errCode = GetInt(print, "err_code", 0);
                            _state.LastCommandReason = !string.IsNullOrWhiteSpace(rsn)
                                ? rsn
                                : (errCode != 0 ? ("Error code " + errCode) : _state.LastCommandResult);
                            _state.LastCommandAtUtc = DateTime.UtcNow.ToString("o");
                        }
                    }

                    // Parse ams_mapping2 (AMS 2 Pro / AMS HT structured mapping) and ams_mapping (legacy flat array)
                    var map2List = AsObjectList(print.ContainsKey("ams_mapping2") ? print["ams_mapping2"] : null);
                    var map1List = AsObjectList(print.ContainsKey("ams_mapping") ? print["ams_mapping"] : null);

                    if (map2List != null)
                    {
                        var keyList = new List<string>();
                        foreach (var item in map2List)
                        {
                            var mDict = item as Dictionary<string, object>;
                            if (mDict == null) { keyList.Add(""); continue; }
                            int aId = GetInt(mDict, "ams_id", -1);
                            int sId = GetInt(mDict, "slot_id", 0);
                            if (aId == 254 || aId == 255) keyList.Add("EXT");
                            else if (aId >= 128) keyList.Add("HT-" + ((aId - 128) + 1));
                            else if (aId >= 0) keyList.Add(((char)('A' + Math.Min(aId, 25))).ToString() + (sId + 1));
                            else keyList.Add("");
                        }
                        if (keyList.Count > 0)
                        {
                            _state.AmsMappingKeys = keyList;
                            _activeJobMappingKeys = new List<string>(keyList);
                        }
                    }
                    else if (map1List != null)
                    {
                        var mapList = new List<int>();
                        var keyList = new List<string>();
                        foreach (var item in map1List)
                        {
                            int idx = Convert.ToInt32(item);
                            mapList.Add(idx);
                            if (idx == 254 || idx == 255) keyList.Add("EXT");
                            else if (idx >= 128) keyList.Add("HT-" + ((idx - 128) + 1));
                            else if (idx >= 0) keyList.Add(((char)('A' + Math.Min(idx / 4, 25))).ToString() + ((idx % 4) + 1));
                            else keyList.Add("");
                        }
                        if (mapList.Count > 0)
                        {
                            _state.AmsMapping = mapList;
                            _activeJobMapping = new List<int>(mapList);
                            _state.AmsMappingKeys = keyList;
                            _activeJobMappingKeys = new List<string>(keyList);
                        }
                    }

                    // Track active print job & detect completion transition
                    string upperState = (newGcodeState ?? "").ToUpperInvariant();
                    if (upperState == "RUNNING" || upperState == "PREPARE" || upperState == "PAUSE")
                    {
                        if (!string.IsNullOrWhiteSpace(gcodeFile)) _activeJobFile = gcodeFile;
                        if (!string.IsNullOrWhiteSpace(subtask)) _activeJobSubtask = subtask;
                        if (mcPercent > _activeJobMaxPercent) _activeJobMaxPercent = mcPercent;
                    }
                    else if ((upperState == "FINISH" || upperState == "FAILED") &&
                             (_prevGcodeState == "RUNNING" || _prevGcodeState == "PAUSE"))
                    {
                        _state.LastFinishedJobId = Guid.NewGuid().ToString("N");
                        _state.LastFinishedFileName = !string.IsNullOrWhiteSpace(_activeJobFile) ? _activeJobFile : _activeJobSubtask;
                        _state.LastFinishedState = upperState;
                        _state.LastFinishedPercent = upperState == "FINISH" ? 100 : Math.Max(1, _activeJobMaxPercent);
                        _state.LastFinishedMapping = new List<int>(_activeJobMapping);
                        _state.LastFinishedMappingKeys = new List<string>(_activeJobMappingKeys);
                        _state.LastFinishedAtUtc = DateTime.UtcNow.ToString("o");
                        _activeJobMaxPercent = 0;
                    }
                    _prevGcodeState = upperState;

                    // Parse AMS telemetry (supports multiple AMS 2 Pro + AMS HT)
                    if (print.ContainsKey("ams") && print["ams"] is Dictionary<string, object>)
                    {
                        var amsRoot = (Dictionary<string, object>)print["ams"];
                        string trayNow = GetString(amsRoot, "tray_now", _state.ActiveTrayNow);
                        _state.ActiveTrayNow = trayNow;

                        var unitArr = AsObjectList(amsRoot.ContainsKey("ams") ? amsRoot["ams"] : null);
                        if (unitArr != null)
                        {
                            var updatedUnits = new List<LiveAmsUnit>();
                            foreach (var uObj in unitArr)
                            {
                                var uDict = uObj as Dictionary<string, object>;
                                if (uDict == null) continue;

                                int amsId = GetInt(uDict, "id", 0);
                                var traysObj = AsObjectList(uDict.ContainsKey("tray") ? uDict["tray"] : null);
                                int trayCount = traysObj != null ? traysObj.Count : 4;

                                bool isHt = amsId >= 128 || trayCount == 1;
                                string unitType = isHt ? "AMS HT" : "AMS 2 Pro";
                                string label = isHt
                                    ? "AMS HT #" + ((amsId >= 128 ? amsId - 128 : amsId) + 1)
                                    : "AMS 2 Pro " + (char)('A' + Math.Min(amsId, 25));

                                var unit = new LiveAmsUnit
                                {
                                    AmsId = amsId,
                                    UnitType = unitType,
                                    Label = label,
                                    TempC = GetDouble(uDict, "temp", 0),
                                    HumidityLevel = GetInt(uDict, "humidity", 0),
                                    HumidityRaw = GetInt(uDict, "humidity_raw", 0),
                                    DryTimeMinutes = GetInt(uDict, "dry_time", 0)
                                };

                                if (traysObj != null)
                                {
                                    foreach (var tObj in traysObj)
                                    {
                                        var tDict = tObj as Dictionary<string, object>;
                                        if (tDict == null) continue;
                                        int slotId = GetInt(tDict, "id", 0);
                                        int trayState = GetInt(tDict, "state", -1);
                                        string trayType = GetString(tDict, "tray_type", "");
                                        bool isEmpty = string.IsNullOrWhiteSpace(trayType) || trayState == 0;
                                        string slotKey = isHt
                                            ? "HT-" + ((amsId >= 128 ? amsId - 128 : amsId) + 1)
                                            : ((char)('A' + Math.Min(amsId, 25))).ToString() + (slotId + 1);

                                        string trayUuid = GetString(tDict, "tray_uuid", "");
                                        string tagUid = GetString(tDict, "tag_uid", "");
                                        int remainPct = GetInt(tDict, "remain", -1);
                                        bool hasRealUuid = !string.IsNullOrWhiteSpace(trayUuid) && !Regex.IsMatch(trayUuid, "^0+$");
                                        bool hasRealTag = !string.IsNullOrWhiteSpace(tagUid) && !Regex.IsMatch(tagUid, "^0+$");
                                        bool hasRfid = hasRealUuid || hasRealTag || remainPct >= 0;

                                        string infoIdx = GetString(tDict, "tray_info_idx", "");
                                        string subBrand = GetString(tDict, "tray_sub_brands", "");
                                        string normColor = ThreeMfParser.NormalizeHexColor(GetString(tDict, "tray_color", "#64748B"));
                                        string profileName = !string.IsNullOrWhiteSpace(subBrand)
                                            ? subBrand
                                            : LookupBambuProfileName(infoIdx, trayType);
                                        string colorName = isEmpty ? "" : GetFriendlyColorName(normColor);

                                        unit.Trays.Add(new LiveAmsTray
                                        {
                                            AmsId = amsId,
                                            SlotId = slotId,
                                            SlotKey = slotKey,
                                            State = trayState,
                                            TrayType = isEmpty ? "" : trayType,
                                            SubBrand = subBrand,
                                            TrayInfoIdx = infoIdx,
                                            ProfileName = isEmpty ? "" : profileName,
                                            ColorName = colorName,
                                            Color = normColor,
                                            NozzleTempMin = GetInt(tDict, "nozzle_temp_min", 0),
                                            NozzleTempMax = GetInt(tDict, "nozzle_temp_max", 0),
                                            BedTemp = GetInt(tDict, "bed_temp", 0),
                                            Diameter = GetString(tDict, "tray_diameter", "1.75"),
                                            RemainPercent = remainPct,
                                            HasRfid = hasRfid,
                                            TrayUuid = hasRealUuid ? trayUuid : "",
                                            TagUid = hasRealTag ? tagUid : "",
                                            TrayWeight = GetDouble(tDict, "tray_weight", 0),
                                            IsEmpty = isEmpty
                                        });
                                    }
                                }
                                updatedUnits.Add(unit);
                            }

                            if (updatedUnits.Count > 0)
                            {
                                _state.AmsUnits = updatedUnits.OrderBy(u => u.AmsId).ToList();
                            }
                        }
                    }

                    // Parse External Spool (vt_tray)
                    if (print.ContainsKey("vt_tray") && print["vt_tray"] is Dictionary<string, object>)
                    {
                        var vt = (Dictionary<string, object>)print["vt_tray"];
                        string tType = GetString(vt, "tray_type", "");
                        _state.ExternalTray = new LiveAmsTray
                        {
                            AmsId = 254,
                            SlotId = 0,
                            SlotKey = "EXT",
                            TrayType = tType,
                            SubBrand = GetString(vt, "tray_sub_brands", ""),
                            Color = ThreeMfParser.NormalizeHexColor(GetString(vt, "tray_color", "#94A3B8")),
                            RemainPercent = GetInt(vt, "remain", -1),
                            TrayWeight = GetDouble(vt, "tray_weight", 1000),
                            IsEmpty = string.IsNullOrWhiteSpace(tType)
                        };
                    }
                }
            }
            catch
            {
                // Ignore malformed partial frames
            }
        }

        private static string LookupBambuProfileName(string idx, string trayType)
        {
            string code = (idx ?? "").Trim().ToUpperInvariant();
            switch (code)
            {
                case "GFA00": return "Bambu PLA Basic";
                case "GFA01": return "Bambu PLA Matte";
                case "GFA02": return "Bambu PLA Metal";
                case "GFA05": return "Bambu PLA Silk";
                case "GFA06": return "Bambu PLA Silk+";
                case "GFA07": return "Bambu PLA Marble";
                case "GFA08": return "Bambu PLA Sparkle";
                case "GFA09": return "Bambu PLA Tough";
                case "GFA11": return "Bambu PLA Aero";
                case "GFA12": return "Bambu PLA Glow";
                case "GFA50": return "Bambu PLA-CF";
                case "GFL99": return "Generic PLA";
                case "GFL98": return "Generic PLA-CF";
                case "GFL95": return "Generic PLA High Speed";
                case "GFL96": return "Generic PLA Silk";
                case "GFG00": return "Bambu PETG Basic";
                case "GFG01": return "Bambu PETG Translucent";
                case "GFG02": return "Bambu PETG HF";
                case "GFG50": return "Bambu PETG-CF";
                case "GFG99": return "Generic PETG";
                case "GFB00": return "Bambu ABS";
                case "GFB01": return "Bambu ASA";
                case "GFB50": return "Bambu ABS-GF";
                case "GFB99": return "Generic ABS";
                case "GFB98": return "Generic ASA";
                case "GFU00": return "Bambu TPU 95A HF";
                case "GFU01": return "Bambu TPU 95A";
                case "GFU99": return "Generic TPU";
                case "GFN03": return "Bambu PA-CF";
                case "GFN04": return "Bambu PAHT-CF";
                case "GFN05": return "Bambu PA6-CF";
                case "GFN08": return "Bambu PA6-GF";
                case "GFN99": return "Generic PA";
                case "GFN98": return "Generic PA-CF";
                case "GFC00": return "Bambu PC";
                case "GFC99": return "Generic PC";
                case "GFS00": return "Bambu Support W";
                case "GFS01": return "Bambu Support G";
                case "GFS02": return "Bambu Support PLA/PETG";
                case "GFS04": return "Bambu PVA";
                default:
                    if (!string.IsNullOrWhiteSpace(trayType))
                        return "Generic " + trayType;
                    return "Filament";
            }
        }

        private static string GetFriendlyColorName(string hex)
        {
            if (string.IsNullOrWhiteSpace(hex) || !hex.StartsWith("#") || hex.Length < 7) return "";
            try
            {
                int r = Convert.ToInt32(hex.Substring(1, 2), 16);
                int g = Convert.ToInt32(hex.Substring(3, 2), 16);
                int b = Convert.ToInt32(hex.Substring(5, 2), 16);

                var named = new[]
                {
                    new { N = "Black",      R = 22,  G = 22,  B = 22  },
                    new { N = "Charcoal",   R = 55,  G = 58,  B = 64  },
                    new { N = "Gray",       R = 128, G = 128, B = 128 },
                    new { N = "Silver",     R = 192, G = 196, B = 204 },
                    new { N = "White",      R = 248, G = 248, B = 248 },
                    new { N = "Beige",      R = 211, G = 197, B = 163 },
                    new { N = "Brown",      R = 130, G = 82,  B = 46  },
                    new { N = "Red",        R = 220, G = 38,  B = 38  },
                    new { N = "Orange",     R = 249, G = 140, B = 54  },
                    new { N = "Yellow",     R = 250, G = 235, B = 68  },
                    new { N = "Green",      R = 5,   G = 140, B = 72  },
                    new { N = "Teal",       R = 20,  G = 184, B = 166 },
                    new { N = "Cyan",       R = 56,  G = 189, B = 248 },
                    new { N = "Blue",       R = 37,  G = 99,  B = 235 },
                    new { N = "Navy",       R = 30,  G = 58,  B = 138 },
                    new { N = "Purple",     R = 147, G = 51,  B = 234 },
                    new { N = "Pink",       R = 236, G = 72,  B = 153 }
                };

                string best = "";
                double bestD = double.MaxValue;
                foreach (var c in named)
                {
                    double d = Math.Sqrt((r - c.R) * (r - c.R) + (g - c.G) * (g - c.G) + (b - c.B) * (b - c.B));
                    if (d < bestD) { bestD = d; best = c.N; }
                }
                return best;
            }
            catch { return ""; }
        }

        private static List<object> AsObjectList(object val)
        {
            if (val == null || val is string) return null;
            var enumerable = val as System.Collections.IEnumerable;
            if (enumerable == null) return null;
            var list = new List<object>();
            foreach (var item in enumerable) list.Add(item);
            return list;
        }

        private static string GetString(Dictionary<string, object> d, string k, string defVal)
        {
            if (!d.ContainsKey(k) || d[k] == null) return defVal;
            return Convert.ToString(d[k], CultureInfo.InvariantCulture);
        }

        private static int GetInt(Dictionary<string, object> d, string k, int defVal)
        {
            if (!d.ContainsKey(k) || d[k] == null) return defVal;
            int v;
            if (int.TryParse(Convert.ToString(d[k], CultureInfo.InvariantCulture), out v)) return v;
            double dv;
            if (double.TryParse(Convert.ToString(d[k], CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out dv))
                return (int)Math.Round(dv);
            return defVal;
        }

        private static double GetDouble(Dictionary<string, object> d, string k, double defVal)
        {
            if (!d.ContainsKey(k) || d[k] == null) return defVal;
            double v;
            if (double.TryParse(Convert.ToString(d[k], CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out v))
                return v;
            return defVal;
        }

        // --- Minimal MQTT 3.1.1 wire helpers ---
        private void SendConnect(string clientId, string user, string pass, ushort keepAliveSec)
        {
            var body = new List<byte>();
            // Protocol Name "MQTT"
            WriteMqttString(body, "MQTT");
            body.Add(4); // Protocol Level 3.1.1
            body.Add(0xC2); // CleanSession | Username | Password
            body.Add((byte)(keepAliveSec >> 8));
            body.Add((byte)(keepAliveSec & 0xFF));
            WriteMqttString(body, clientId);
            WriteMqttString(body, user);
            WriteMqttString(body, pass);

            WritePacket(0x10, body.ToArray());
        }

        private void SendSubscribe(ushort packetId, string topic)
        {
            var body = new List<byte>();
            body.Add((byte)(packetId >> 8));
            body.Add((byte)(packetId & 0xFF));
            WriteMqttString(body, topic);
            body.Add(0x00); // QoS 0
            WritePacket(0x82, body.ToArray());
        }

        private void SendPublish(string topic, string payload)
        {
            var body = new List<byte>();
            WriteMqttString(body, topic);
            body.AddRange(Encoding.UTF8.GetBytes(payload));
            WritePacket(0x30, body.ToArray());
        }

        private void SendPingReq()
        {
            WritePacket(0xC0, new byte[0]);
        }

        private void WriteMqttString(List<byte> buf, string s)
        {
            byte[] b = Encoding.UTF8.GetBytes(s ?? "");
            buf.Add((byte)(b.Length >> 8));
            buf.Add((byte)(b.Length & 0xFF));
            buf.AddRange(b);
        }

        private void WritePacket(byte header, byte[] body)
        {
            var pkt = new List<byte> { header };
            int x = body.Length;
            do
            {
                byte encoded = (byte)(x % 128);
                x /= 128;
                if (x > 0) encoded |= 128;
                pkt.Add(encoded);
            } while (x > 0);
            pkt.AddRange(body);

            byte[] arr = pkt.ToArray();
            _ssl.Write(arr, 0, arr.Length);
            _ssl.Flush();
        }

        private byte[] ReadPacket(int timeoutMs)
        {
            _tcp.ReceiveTimeout = timeoutMs;
            int first;
            try
            {
                first = _ssl.ReadByte();
            }
            catch (IOException)
            {
                return null; // timeout
            }
            if (first < 0) throw new IOException("MQTT connection closed by printer.");

            var headerBytes = new List<byte> { (byte)first };
            int multiplier = 1;
            int remainingLength = 0;
            byte encodedByte;
            do
            {
                int b = _ssl.ReadByte();
                if (b < 0) throw new IOException("Unexpected EOF reading MQTT length.");
                encodedByte = (byte)b;
                headerBytes.Add(encodedByte);
                remainingLength += (encodedByte & 127) * multiplier;
                multiplier *= 128;
            } while ((encodedByte & 128) != 0);

            byte[] payload = new byte[remainingLength];
            int read = 0;
            while (read < remainingLength)
            {
                int n = _ssl.Read(payload, read, remainingLength - read);
                if (n <= 0) throw new IOException("Unexpected EOF reading MQTT payload.");
                read += n;
            }

            byte[] full = new byte[headerBytes.Count + remainingLength];
            Buffer.BlockCopy(headerBytes.ToArray(), 0, full, 0, headerBytes.Count);
            Buffer.BlockCopy(payload, 0, full, headerBytes.Count, remainingLength);
            return full;
        }

        private static int DecodeRemainingLength(byte[] buf, ref int idx)
        {
            int multiplier = 1;
            int value = 0;
            byte encodedByte;
            do
            {
                encodedByte = buf[idx++];
                value += (encodedByte & 127) * multiplier;
                multiplier *= 128;
            } while ((encodedByte & 128) != 0 && idx < buf.Length);
            return value;
        }

        public void Dispose()
        {
            Disconnect();
        }
    }

    public class SimpleHttpRequest
    {
        public string Method { get; set; }
        public string Path { get; set; }
        public string Query { get; set; }
        public Dictionary<string, string> Headers { get; set; }
        public byte[] BodyBytes { get; set; }
        internal TcpClient Client { get; set; }
        internal NetworkStream Stream { get; set; }

        public SimpleHttpRequest()
        {
            Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            BodyBytes = new byte[0];
        }

        public string GetHeader(string name)
        {
            string v;
            return Headers.TryGetValue(name, out v) ? v : null;
        }

        public string GetBodyText()
        {
            return BodyBytes.Length > 0 ? Encoding.UTF8.GetString(BodyBytes) : "";
        }

        public void SendResponse(int statusCode, string contentType, byte[] body, string cacheControl)
        {
            try
            {
                string reason = statusCode == 200 ? "OK" : statusCode == 400 ? "Bad Request" : statusCode == 404 ? "Not Found" : "Internal Server Error";
                var sb = new StringBuilder();
                sb.AppendFormat("HTTP/1.1 {0} {1}\r\n", statusCode, reason);
                sb.AppendFormat("Content-Type: {0}\r\n", contentType);
                sb.AppendFormat("Content-Length: {0}\r\n", body.Length);
                if (!string.IsNullOrEmpty(cacheControl))
                {
                    sb.AppendFormat("Cache-Control: {0}\r\n", cacheControl);
                }
                sb.Append("Connection: close\r\n\r\n");

                byte[] headerBytes = Encoding.ASCII.GetBytes(sb.ToString());
                Stream.Write(headerBytes, 0, headerBytes.Length);
                if (body.Length > 0)
                {
                    Stream.Write(body, 0, body.Length);
                }
                Stream.Flush();
            }
            catch { }
            finally
            {
                try { Stream.Close(); } catch { }
                try { Client.Close(); } catch { }
            }
        }
    }

    public class SimpleHttpServer : IDisposable
    {
        private TcpListener _listener;
        public int Port { get; private set; }
        public bool IsListening { get; private set; }

        public void Start(int port)
        {
            _listener = new TcpListener(IPAddress.Loopback, port);
            _listener.Start();
            Port = port;
            IsListening = true;
        }

        public SimpleHttpRequest AcceptRequest()
        {
            while (IsListening)
            {
                TcpClient client = _listener.AcceptTcpClient();
                client.ReceiveTimeout = 15000;
                client.SendTimeout = 15000;
                NetworkStream stream = client.GetStream();

                try
                {
                    var req = ReadHttpRequest(client, stream);
                    if (req != null) return req;
                }
                catch { }

                try { stream.Close(); } catch { }
                try { client.Close(); } catch { }
            }
            return null;
        }

        private static SimpleHttpRequest ReadHttpRequest(TcpClient client, NetworkStream stream)
        {
            // Read headers byte-by-byte up to \r\n\r\n
            var headerBuf = new List<byte>(1024);
            int state = 0; // tracks \r\n\r\n
            while (headerBuf.Count < 65536)
            {
                int b = stream.ReadByte();
                if (b < 0) return null;
                headerBuf.Add((byte)b);
                if ((state == 0 || state == 2) && b == '\r') state++;
                else if ((state == 1 || state == 3) && b == '\n') state++;
                else state = (b == '\r') ? 1 : 0;
                if (state == 4) break;
            }
            if (state != 4) return null;

            string headerText = Encoding.ASCII.GetString(headerBuf.ToArray());
            string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries);
            if (lines.Length == 0) return null;

            string[] reqLine = lines[0].Split(' ');
            if (reqLine.Length < 2) return null;

            var req = new SimpleHttpRequest
            {
                Method = reqLine[0].ToUpperInvariant(),
                Client = client,
                Stream = stream
            };

            string rawTarget = reqLine[1];
            int qIdx = rawTarget.IndexOf('?');
            if (qIdx >= 0)
            {
                req.Path = rawTarget.Substring(0, qIdx);
                req.Query = rawTarget.Substring(qIdx + 1);
            }
            else
            {
                req.Path = rawTarget;
                req.Query = "";
            }

            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon > 0)
                {
                    string k = lines[i].Substring(0, colon).Trim();
                    string v = lines[i].Substring(colon + 1).Trim();
                    req.Headers[k] = v;
                }
            }

            // Support Expect: 100-continue
            string expect = req.GetHeader("Expect");
            if (!string.IsNullOrEmpty(expect) && expect.IndexOf("100-continue", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                byte[] cont = Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");
                stream.Write(cont, 0, cont.Length);
                stream.Flush();
            }

            // Read Content-Length body if present
            int contentLen = 0;
            string clStr = req.GetHeader("Content-Length");
            if (!string.IsNullOrEmpty(clStr)) int.TryParse(clStr, out contentLen);

            if (contentLen > 0 && contentLen < 120 * 1024 * 1024)
            {
                byte[] body = new byte[contentLen];
                int read = 0;
                while (read < contentLen)
                {
                    int n = stream.Read(body, read, contentLen - read);
                    if (n <= 0) break;
                    read += n;
                }
                req.BodyBytes = body;
            }

            return req;
        }

        public void Stop()
        {
            IsListening = false;
            try { if (_listener != null) _listener.Stop(); } catch { }
        }

        public void Dispose()
        {
            Stop();
        }
    }
}
