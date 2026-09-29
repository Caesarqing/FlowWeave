from service import load
import requests as req
import os

def start():
    label = "中文😀"; load()
    req.get("https://local-source.test")
    os.ReadFile("local.txt")

def shadow(load, client):
    label = "中文😀"; load()
    client.run()
