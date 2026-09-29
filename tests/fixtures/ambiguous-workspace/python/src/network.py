from urllib.request import Request, urlopen
from http.client import HTTPConnection, HTTPSConnection

def request(host):
    prepared = Request(url="https://urllib.test/users", method="POST")
    urlopen(url=prepared)
    urlopen("https://stdlib.test/users")
    connection = HTTPSConnection("service.test", 443)
    connection.request("GET", "/api")
    HTTPConnection(host).request("GET", "/unknown")

def shadow(urlopen):
    urlopen("https://shadow.test")
