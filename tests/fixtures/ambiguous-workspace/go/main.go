package main
import h "example.test/ambiguity/http"
import real "net/http"
type Api interface { Work() }
func main() { label := "中文😀"; Load(); h.Get("https://local-source.test"); real.HandleFunc("/route", nil); _ = label }
func shadow(api Api, real string) { api.Work(); real.Get("https://shadow.test") }
